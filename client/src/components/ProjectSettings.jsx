import React, { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';

const COLOR_PALETTE = [
  '#7c3aed', // Purple
  '#2563eb', // Blue
  '#0891b2', // Cyan
  '#059669', // Green
  '#ca8a04', // Yellow
  '#ea580c', // Orange
  '#dc2626', // Red
  '#db2777', // Pink
  '#7c2d12', // Brown
  '#4b5563', // Gray
  '#0f766e', // Teal
  '#4f46e5', // Indigo
];

function ProjectSettings({ project, onClose }) {
  const { updateProject, deleteProject, user, addContributor, removeContributor, getProjectPaths, setProjectHostPath } = useApp();
  const [showEdit, setShowEdit] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showContributors, setShowContributors] = useState(false);
  const [showPaths, setShowPaths] = useState(false);
  const [availableUsers, setAvailableUsers] = useState([]);
  const [contribError, setContribError] = useState('');
  const [pathRows, setPathRows] = useState([]);
  const [pathEdits, setPathEdits] = useState({});
  const [pathError, setPathError] = useState('');
  const [pathSaving, setPathSaving] = useState(null);
  const [pathSaved, setPathSaved] = useState(null);
  const [editData, setEditData] = useState({
    name: project.name,
    path: project.path || '',
    description: project.description || '',
  });

  const isOwner = project.contributors?.some(c => c.id === user?.id && c.project_role === 'owner');
  const isAdmin = user?.role === 'admin';
  const canManage = isOwner || isAdmin;

  const loadAvailableUsers = async () => {
    try {
      const res = await fetch(`/api/projects/${project.id}/available-users`);
      if (res.ok) {
        setAvailableUsers(await res.json());
      }
    } catch (err) {
      console.error('Failed to load available users:', err);
    }
  };

  useEffect(() => {
    if (showContributors && canManage) {
      loadAvailableUsers();
    }
  }, [showContributors]);

  const loadPaths = async () => {
    try {
      const rows = await getProjectPaths(project.id);
      setPathRows(rows);
      const edits = {};
      rows.forEach((r) => { edits[r.hostId] = r.path || ''; });
      setPathEdits(edits);
    } catch (err) {
      setPathError(err.message);
    }
  };

  useEffect(() => {
    if (showPaths && canManage) {
      setPathError('');
      loadPaths();
    }
  }, [showPaths]);

  const handleSavePath = async (row) => {
    setPathError('');
    setPathSaving(row.hostId);
    try {
      const value = (pathEdits[row.hostId] || '').trim();
      // Remote rows create the directory on the host (create=true); the local
      // row just updates projects.path.
      await setProjectHostPath(project.id, row.hostId, value, !row.isLocal);
      await loadPaths();
      setPathSaved(row.hostId);
      setTimeout(() => setPathSaved(null), 2000);
    } catch (err) {
      setPathError(err.message);
    } finally {
      setPathSaving(null);
    }
  };

  const handleColorChange = async (color) => {
    await updateProject(project.id, { color });
  };

  const handleSaveEdit = async () => {
    await updateProject(project.id, editData);
    setShowEdit(false);
  };

  const handleDelete = async () => {
    await deleteProject(project.id);
    onClose();
  };

  const handleAddContributor = async (userId) => {
    setContribError('');
    try {
      await addContributor(project.id, userId);
      await loadAvailableUsers();
    } catch (err) {
      setContribError(err.message);
    }
  };

  const handleRemoveContributor = async (userId) => {
    setContribError('');
    try {
      await removeContributor(project.id, userId);
      await loadAvailableUsers();
    } catch (err) {
      setContribError(err.message);
    }
  };

  const contributors = project.contributors || [];
  const owners = contributors.filter(c => c.project_role === 'owner');

  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onClose} />
      <div className="absolute right-0 top-full mt-1 w-72 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-20 max-h-96 overflow-y-auto">
        {!showEdit && !showContributors && !showPaths ? (
          <>
            {/* Color picker */}
            <div className="p-3 border-b border-gray-700">
              <div className="text-xs text-gray-400 mb-2">Color</div>
              <div className="flex flex-wrap gap-2">
                {COLOR_PALETTE.map((color) => (
                  <button
                    key={color}
                    onClick={() => handleColorChange(color)}
                    className={`w-6 h-6 rounded-full transition-transform hover:scale-110 ${
                      project.color === color ? 'ring-2 ring-white ring-offset-2 ring-offset-gray-800' : ''
                    }`}
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
            </div>

            {/* Menu items */}
            <div className="py-1">
              {canManage && (
                <button
                  onClick={() => setShowEdit(true)}
                  className="w-full px-3 py-2 text-left text-sm text-gray-300 hover:bg-gray-700 flex items-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                  Edit details
                </button>
              )}
              <button
                onClick={() => setShowContributors(true)}
                className="w-full px-3 py-2 text-left text-sm text-gray-300 hover:bg-gray-700 flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197m13.5-9a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
                </svg>
                Contributors ({contributors.length})
              </button>
              {canManage && (
                <button
                  onClick={() => setShowPaths(true)}
                  className="w-full px-3 py-2 text-left text-sm text-gray-300 hover:bg-gray-700 flex items-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                  Working directories
                </button>
              )}
              {canManage && (
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  className="w-full px-3 py-2 text-left text-sm text-red-400 hover:bg-gray-700 flex items-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                  Delete project
                </button>
              )}
            </div>
          </>
        ) : showContributors ? (
          /* Contributors view */
          <div className="p-3">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-medium text-white">Contributors</div>
              <button onClick={() => setShowContributors(false)} className="text-xs text-gray-400 hover:text-white">
                Back
              </button>
            </div>

            {contribError && (
              <div className="bg-red-900/50 border border-red-500 text-red-200 px-2 py-1 rounded text-xs mb-2">
                {contribError}
              </div>
            )}

            <div className="space-y-1 mb-3">
              {contributors.map((c) => (
                <div key={c.id} className="flex items-center justify-between py-1.5 px-2 rounded bg-gray-700/50">
                  <div className="flex items-center gap-2">
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium ${
                      c.project_role === 'owner' ? 'bg-primary-600 text-white' : 'bg-gray-600 text-gray-300'
                    }`}>
                      {c.username[0].toUpperCase()}
                    </div>
                    <span className="text-sm text-white">{c.username}</span>
                    <span className="text-xs text-gray-500 capitalize">{c.project_role}</span>
                  </div>
                  {canManage && c.project_role !== 'owner' && (
                    <button
                      onClick={() => handleRemoveContributor(c.id)}
                      className="text-xs text-red-400 hover:text-red-300"
                    >
                      Remove
                    </button>
                  )}
                  {canManage && c.project_role === 'owner' && owners.length > 1 && (
                    <button
                      onClick={() => handleRemoveContributor(c.id)}
                      className="text-xs text-red-400 hover:text-red-300"
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
            </div>

            {canManage && availableUsers.length > 0 && (
              <div>
                <div className="text-xs text-gray-400 mb-1">Add contributor</div>
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {availableUsers.map((u) => (
                    <button
                      key={u.id}
                      onClick={() => handleAddContributor(u.id)}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-gray-300 hover:bg-gray-700 transition-colors"
                    >
                      <svg className="w-3 h-3 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                      </svg>
                      {u.username}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : showPaths ? (
          /* Working directories view */
          <div className="p-3">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-medium text-white">Working directories</div>
              <button onClick={() => setShowPaths(false)} className="text-xs text-gray-400 hover:text-white">
                Back
              </button>
            </div>

            {pathError && (
              <div className="bg-red-900/50 border border-red-500 text-red-200 px-2 py-1 rounded text-xs mb-2">
                {pathError}
              </div>
            )}

            <div className="space-y-3">
              {pathRows.map((row) => (
                <div key={row.hostId}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-gray-300">
                      {row.hostName}
                      <span className="text-gray-500 ml-1">
                        {row.isLocal ? '(local)' : `(${row.sshTarget})`}
                      </span>
                    </span>
                    {pathSaved === row.hostId && (
                      <span className="text-xs text-green-400">Saved</span>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={pathEdits[row.hostId] ?? ''}
                      onChange={(e) => setPathEdits({ ...pathEdits, [row.hostId]: e.target.value })}
                      placeholder={row.isLocal ? '/home/projects/...' : `/path/on/${row.hostName}`}
                      className="flex-1 px-2 py-1.5 bg-gray-700 border border-gray-600 rounded text-white font-mono text-xs
                                 focus:outline-none focus:ring-1 focus:ring-primary-500"
                    />
                    <button
                      onClick={() => handleSavePath(row)}
                      disabled={pathSaving === row.hostId}
                      className="px-2.5 py-1.5 bg-primary-600 hover:bg-primary-700 text-white text-xs rounded transition-colors disabled:opacity-50"
                    >
                      {pathSaving === row.hostId ? '...' : 'Save'}
                    </button>
                  </div>
                  {!row.isLocal && (
                    <p className="text-xs text-gray-500 mt-1">Created on the host when saved</p>
                  )}
                </div>
              ))}
              {pathRows.length === 0 && (
                <p className="text-xs text-gray-500">No hosts configured.</p>
              )}
            </div>
          </div>
        ) : (
          /* Edit form */
          <div className="p-3">
            <div className="text-sm font-medium text-white mb-3">Edit Project</div>
            <div className="space-y-3">
              <input
                type="text"
                placeholder="Project name"
                value={editData.name}
                onChange={(e) => setEditData({ ...editData, name: e.target.value })}
                className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-white
                           focus:outline-none focus:ring-1 focus:ring-primary-500"
              />
              <input
                type="text"
                placeholder="Path"
                value={editData.path}
                onChange={(e) => setEditData({ ...editData, path: e.target.value })}
                className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-white
                           focus:outline-none focus:ring-1 focus:ring-primary-500"
              />
              <input
                type="text"
                placeholder="Description"
                value={editData.description}
                onChange={(e) => setEditData({ ...editData, description: e.target.value })}
                className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-white
                           focus:outline-none focus:ring-1 focus:ring-primary-500"
              />
              <div className="flex gap-2">
                <button
                  onClick={handleSaveEdit}
                  className="flex-1 px-3 py-1.5 bg-primary-600 hover:bg-primary-700 text-white text-sm rounded transition-colors"
                >
                  Save
                </button>
                <button
                  onClick={() => setShowEdit(false)}
                  className="flex-1 px-3 py-1.5 bg-gray-600 hover:bg-gray-700 text-white text-sm rounded transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Delete confirmation modal */}
      {showDeleteConfirm && (
        <>
          <div className="fixed inset-0 bg-black/50 z-40" onClick={() => setShowDeleteConfirm(false)} />
          <div className="fixed inset-0 flex items-center justify-center z-50 p-4">
            <div className="bg-gray-800 rounded-lg p-6 max-w-sm w-full shadow-xl">
              <h4 className="text-lg font-semibold text-white mb-2">Delete Project?</h4>
              <p className="text-gray-400 mb-4">
                This will delete "{project.name}" and all its agents. This cannot be undone.
              </p>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className="px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white rounded transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDelete}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

export default ProjectSettings;
