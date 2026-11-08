/**
 * A machine's vital signs for the Hosts tab: CPU, load, memory, disk, GPU, uptime.
 *
 * One POSIX sh script per host, fed on stdin (no quoting through ssh), that prints
 * key=value lines and branches on uname -- the fleet is Linux and WSL plus one Mac,
 * and none of the obvious tools (free, mpstat, top's flags) exist on both. CPU is
 * measured, not guessed from load: two /proc/stat samples a second apart on Linux,
 * `top -l 2` on macOS. That second is why results are cached: the tab polls every
 * few seconds, and several open tabs must not each cost every host a second of
 * sampling.
 *
 * The local host's script runs inside Maestro's container, which sees the host's
 * /proc (CPU, memory, uptime are the machine's) but its own root filesystem, so
 * disk is measured on the mounted home directory instead of "/".
 */
import { getHosts } from './db.js';
import { execOnHostWithInput, isRemote } from './hosts.js';

const TTL_MS = 4000;
const TIMEOUT_MS = 12000;

const SCRIPT = String.raw`
R="$1"
OS=$(uname -s)
echo "os=$OS"
if [ "$OS" = Linux ]; then
  s1=$(head -1 /proc/stat); sleep 1; s2=$(head -1 /proc/stat)
  echo "$s1 $s2" | awk '{t1=0;t2=0;for(i=2;i<=9;i++)t1+=$i;for(i=13;i<=20;i++)t2+=$i;
    d=t2-t1; if(d>0) printf "cpu=%.1f\n", 100*(1-(($16+$17)-($5+$6))/d)}'
  echo "ncpu=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)"
  echo "load=$(cut -d' ' -f1-3 /proc/loadavg)"
  awk '/^MemTotal:/{printf "memtotal=%.0f\n", $2*1024} /^MemAvailable:/{printf "memavail=%.0f\n", $2*1024}
       /^SwapTotal:/{printf "swaptotal=%.0f\n", $2*1024} /^SwapFree:/{printf "swapfree=%.0f\n", $2*1024}' /proc/meminfo
  echo "uptime=$(cut -d. -f1 /proc/uptime)"
  [ -r /proc/sys/kernel/osrelease ] && grep -qi microsoft /proc/sys/kernel/osrelease && echo "wsl=1"
elif [ "$OS" = Darwin ]; then
  echo "ncpu=$(sysctl -n hw.ncpu)"
  echo "load=$(sysctl -n vm.loadavg | tr -d '{}' | awk '{print $1, $2, $3}')"
  echo "memtotal=$(sysctl -n hw.memsize)"
  vm_stat | awk -v ps="$(pagesize)" '/Pages free/{f=$3+0} /Pages inactive/{i=$3+0}
    /Pages speculative/{s=$3+0} /Pages purgeable/{p=$3+0}
    END{printf "memavail=%.0f\n", (f+i+s+p)*ps}'
  top -l 2 -n 0 -s 1 | awk '/CPU usage/{for(i=1;i<=NF;i++) if($i=="idle") v=$(i-1)}
    END{gsub("%","",v); if(v!="") printf "cpu=%.1f\n", 100-v}'
  b=$(sysctl -n kern.boottime | sed 's/^{ sec = \([0-9]*\).*/\1/'); echo "uptime=$(( $(date +%s) - b ))"
fi
# Deduped by size+free, not device: macOS reports "/" and its Data volume (one APFS
# container), and the container reports its overlay and the bind mount, each as two
# "disks" that are the same space.
df -Pk / $R 2>/dev/null | awk 'NR>1 && !seen[$2 " " $4]++ {printf "disk=%s|%.0f|%.0f\n", $6, $2*1024, $4*1024}'
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null |
    sed 's/, */|/g; s/^/gpu=/'
fi
`;

function parse(stdout) {
  const s = { disks: [], gpus: [] };
  for (const line of String(stdout).split('\n')) {
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i);
    const v = line.slice(i + 1).trim();
    if (k === 'disk') {
      const [mount, size, avail] = v.split('|');
      s.disks.push({ mount, size: Number(size), avail: Number(avail) });
    } else if (k === 'gpu') {
      const [name, util, used, total] = v.split('|');
      // nvidia-smi reports MiB
      s.gpus.push({ name, util: Number(util), memUsed: Number(used) * 1048576, memTotal: Number(total) * 1048576 });
    } else if (k === 'load') {
      s.load = v.split(/\s+/).map(Number);
    } else if (k === 'os') {
      s.os = v;
    } else if (k === 'wsl') {
      s.wsl = true;
    } else {
      const n = Number(v);
      if (Number.isFinite(n)) s[{ cpu: 'cpuPct', ncpu: 'ncpu', memtotal: 'memTotal', memavail: 'memAvail',
        swaptotal: 'swapTotal', swapfree: 'swapFree', uptime: 'uptimeS' }[k] || k] = n;
    }
  }
  return s;
}

const cache = new Map(); // hostId -> { at, value, inflight }

async function measure(host) {
  // In the container, "/" is the image; the mounted home is the machine's disk.
  const root = isRemote(host) ? host.default_root || '' : process.env.HOME || '/home/dave';
  const cmd = `sh -s -- '${String(root).replace(/'/g, `'\\''`)}'`;
  try {
    const { stdout } = await execOnHostWithInput(host, cmd, SCRIPT, { timeout: TIMEOUT_MS });
    return { ...parse(stdout), at: new Date().toISOString() };
  } catch (err) {
    return { error: /timed out/.test(err.message) ? 'timed out' : 'unreachable', at: new Date().toISOString() };
  }
}

function statsFor(host) {
  const e = cache.get(host.id);
  if (e && e.value && Date.now() - e.at < TTL_MS) return Promise.resolve(e.value);
  if (e && e.inflight) return e.inflight;
  const inflight = measure(host).then((value) => {
    cache.set(host.id, { at: Date.now(), value, inflight: null });
    return value;
  });
  cache.set(host.id, { ...(e || {}), inflight });
  return inflight;
}

/** { [hostId]: stats | {error} } for every host, measured in parallel. */
export async function allHostStats() {
  const hosts = getHosts();
  const out = {};
  await Promise.all(hosts.map(async (h) => {
    if (h.ssh_target && h.status === 'offline') { out[h.id] = { error: 'offline' }; return; }
    out[h.id] = await statsFor(h);
  }));
  return out;
}
