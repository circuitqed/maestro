/**
 * Receiving a file onto a host, in resumable chunks.
 *
 * Extracted from the agent-chat upload route so hosts can use the same machinery.
 * The caller resolves WHERE (a host and a base directory) and does its own auth;
 * everything here is about getting bytes there intact.
 *
 * Three things this exists to get right, each learned the hard way:
 *
 * 1. CLOUDFLARE CUTS LONG REQUESTS. The dashboard is reached through a tunnel, and
 *    Cloudflare kills any request whose origin has not answered within ~100s — and
 *    an upload's origin cannot answer until the last byte lands. So a single-request
 *    upload is capped not by file size but by how much of the user's uplink fits in
 *    100 seconds. Measured: a 40MB upload at 100KB/s died at 13,893,632 bytes after
 *    137s. Hence chunks, each finishing well inside the window.
 *
 * 2. A CUT CONNECTION LOOKS EXACTLY LIKE A FINISHED ONE. The write stream closes
 *    the same way either way, so completion is decided by the BYTE COUNT, never by
 *    the sink closing. Getting this wrong answered 200 with a truncated file: a
 *    25MB .pptx landed as 24,883,913 bytes of valid-looking pptx that no longer
 *    opened, and the chat reported success.
 *
 * 3. OVER SSH, BYTES IN FLIGHT WHEN THE PIPE DIES NEVER LANDED. So on any short or
 *    failed chunk the resume point comes from the destination itself (stat / wc -c),
 *    not from our counter — resuming from a count that is too high yields a file of
 *    the right length that is quietly corrupt.
 */
import fs from 'fs';
import fsp from 'fs/promises';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { isRemote, execOnHost, shellQuote, sshBaseArgs, remoteWrap } from './hosts.js';
import { ensureDirOnHost } from './projectPaths.js';

// Generous by default (attachments can be zips/datasets); override with MAESTRO_MAX_UPLOAD_MB.
export const MAX_UPLOAD_MB = Number(process.env.MAESTRO_MAX_UPLOAD_MB) || 2048;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

// Chunked uploads in progress: uploadId -> where the bytes go and how many landed.
const inflightUploads = new Map();
const UPLOAD_TTL_MS = 60 * 60 * 1000;

/** Drop abandoned sessions so a closed browser tab cannot pin entries forever. */
function sweepInflightUploads() {
  const now = Date.now();
  for (const [id, st] of inflightUploads) {
    if (now - st.at > UPLOAD_TTL_MS) inflightUploads.delete(id);
  }
}

/**
 * Sanitize a client filename to a safe basename: no separators or traversal, tight
 * charset, no leading dot (so nothing arrives hidden). Preserves the extension.
 */
export function safeUploadName(name) {
  let n = String(name || '').replace(/\\/g, '/').split('/').pop().trim();
  n = n.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  if (!n) n = 'file';
  return n.slice(0, 120);
}

async function hostIsFile(host, p) {
  try {
    if (isRemote(host)) {
      await execOnHost(host, `test -f ${shellQuote(p)}`);
      return true;
    }
    return (await fsp.stat(p)).isFile();
  } catch {
    return false;
  }
}

async function hostIsDir(host, p) {
  try {
    if (isRemote(host)) {
      await execOnHost(host, `test -d ${shellQuote(p)}`);
      return true;
    }
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Stream one chunk of an upload to `<baseDir>/<subdir>/<name>` on `host`.
 *
 * @param {object} req  the request; its body is the raw bytes for this chunk
 * @param {object} res
 * @param {object} opts
 * @param {object|null} opts.host     null => local
 * @param {string} opts.baseDir       absolute dir on that host
 * @param {string} [opts.subdir]      created under baseDir; '' to write into baseDir
 * @param {boolean} [opts.gitignore]  write a `*` .gitignore when we create the dir
 */
export async function receiveUpload(req, res, { host, baseDir, subdir = 'uploads', gitignore = true }) {
  let responded = false;
  const done = (code, body) => { if (!responded) { responded = true; res.status(code).json(body); } };

  try {
    // `total` is the whole file; Content-Length is just this chunk. Equal for a
    // single-shot upload, which is still what small files do.
    const expected = Number(req.headers['content-length'] || 0);
    const total = Number(req.query.total || 0) || expected;
    const offset = Number(req.query.offset || 0);
    if (total > MAX_UPLOAD_BYTES || expected > MAX_UPLOAD_BYTES) {
      return done(413, { error: `File exceeds the ${MAX_UPLOAD_MB} MB upload limit` });
    }

    // A continuation is identified by its uploadId, NOT by offset > 0. Keying off
    // the offset made a retry of the FIRST chunk look like a new upload: it opened a
    // second session, hit the name-collision rename, and wrote the rest of the file
    // to `name-a1b2c3d4.ext` while orphaning the first attempt's bytes.
    const resuming = Boolean(req.query.uploadId);
    let state;
    if (resuming) {
      sweepInflightUploads();
      state = inflightUploads.get(String(req.query.uploadId));
      if (!state) return done(410, { error: 'Upload session expired — send the file again to restart it' });
      if (state.scope !== (host ? `h${host.id}` : 'local') + ':' + baseDir) {
        return done(400, { error: 'Upload session belongs to another destination' });
      }
      // Append-only and strictly in order, so a retried or reordered chunk is never
      // written twice. The client resumes from `received`, returned every time.
      if (state.received !== offset) {
        return done(409, { error: 'Out-of-order chunk', received: state.received });
      }
    } else if (offset > 0) {
      return done(400, { error: 'Resuming an upload requires its uploadId' });
    } else {
      const name = safeUploadName(req.query.name);
      const wd = String(baseDir).replace(/\/+$/, '');
      const dir = subdir ? `${wd}/${subdir}` : wd;
      // Only self-manage a .gitignore when WE first create the dir, so a tree that
      // already keeps a tracked directory of its own is never clobbered.
      const dirPreexisted = await hostIsDir(host, dir);
      await ensureDirOnHost(host, dir);
      if (!dirPreexisted && gitignore) {
        try {
          await execOnHost(host, `printf '*\\n' > ${shellQuote(`${dir}/.gitignore`)}`);
        } catch {
          /* non-fatal */
        }
      }

      // Don't clobber an existing file with the same name.
      let finalName = name;
      if (await hostIsFile(host, `${dir}/${finalName}`)) {
        const dot = name.lastIndexOf('.');
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : '';
        finalName = `${stem}-${randomUUID().slice(0, 8)}${ext}`;
      }
      state = {
        scope: (host ? `h${host.id}` : 'local') + ':' + baseDir,
        finalName,
        relPath: subdir ? `${subdir}/${finalName}` : finalName,
        absPath: `${dir}/${finalName}`,
        total,
        received: 0,
        at: Date.now(),
      };
    }

    const { absPath, relPath, finalName } = state;
    const uploadId = resuming ? String(req.query.uploadId) : randomUUID();

    // Enforce the cap even when Content-Length is absent or lying.
    let received = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      received += chunk.length;
      if (!aborted && state.received + received > MAX_UPLOAD_BYTES) { aborted = true; req.destroy(); }
    });

    const discardPartial = async () => {
      try {
        if (isRemote(host)) await execOnHost(host, `rm -f ${shellQuote(absPath)}`);
        else await fsp.unlink(absPath);
      } catch { /* never mask the real error with a cleanup failure */ }
    };

    // What the destination actually holds. Only consulted when a chunk did not land
    // cleanly, so the happy path pays nothing for it.
    const actualSize = async () => {
      try {
        if (isRemote(host)) {
          const { stdout } = await execOnHost(host, `wc -c < ${shellQuote(absPath)} 2>/dev/null || echo 0`);
          return Number(String(stdout).trim()) || 0;
        }
        return (await fsp.stat(absPath)).size;
      } catch {
        return 0;
      }
    };

    const settle = async (sinkCode) => {
      if (aborted) {
        inflightUploads.delete(uploadId);
        await discardPartial();
        return done(413, { error: `File exceeds the ${MAX_UPLOAD_MB} MB upload limit` });
      }
      const clean = !sinkCode && (!expected || received === expected);
      state.received = clean ? state.received + received : await actualSize();
      state.at = Date.now();
      if (sinkCode) {
        inflightUploads.set(uploadId, state);
        return done(502, { error: `Upload failed (ssh ${sinkCode})`, received: state.received });
      }
      if (state.received >= state.total) {
        inflightUploads.delete(uploadId);
        return done(200, { name: finalName, path: relPath, absPath, received: state.received, complete: true });
      }
      inflightUploads.set(uploadId, state);
      return done(200, { uploadId, name: finalName, path: relPath, received: state.received, complete: false });
    };

    if (isRemote(host)) {
      const child = spawn(
        'ssh',
        // Append for every chunk after the first; `>` would truncate what landed.
        [...sshBaseArgs(host), host.ssh_target, remoteWrap(host, `cat ${offset > 0 ? '>>' : '>'} ${shellQuote(absPath)}`)],
        { stdio: ['pipe', 'ignore', 'pipe'] }
      );
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (e) => done(502, { error: `Upload failed: ${e.message}` }));
      child.on('close', (code) => {
        if (code && code !== 0) return done(502, { error: `Upload failed (ssh ${code}): ${stderr.trim()}` });
        settle(0);
      });
      child.stdin.on('error', () => { /* EPIPE if ssh dies first */ });
      req.on('error', () => { try { child.kill('SIGTERM'); } catch { /* gone */ } });
      req.pipe(child.stdin);
    } else {
      const ws = fs.createWriteStream(absPath, offset > 0 ? { flags: 'a' } : undefined);
      ws.on('error', (e) => done(500, { error: `Upload failed: ${e.message}` }));
      ws.on('close', () => { settle(0); });
      req.on('error', () => ws.destroy());
      req.pipe(ws);
    }
  } catch (err) {
    done(500, { error: err.message });
  }
}
