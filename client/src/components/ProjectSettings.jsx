import React, { useState } from 'react';
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
  const { updateProject, deleteProject } = useApp();
  const [showEdit, setShowEdit] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [editData, setEditData] = useState({
    name: project.name,
    path: project.path || '',
    description: project.description || '',
  });

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

  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onClose} />
      <div className="absolute right-0 top-full mt-1 w-64 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-20">
        {!showEdit ? (
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
            </div>
          </>
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
