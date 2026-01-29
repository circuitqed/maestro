import React, { useState } from 'react';
import { useApp } from '../context/AppContext';

function AddAgentForm({ projectId, onClose }) {
  const { createAgent } = useApp();
  const [name, setName] = useState('');
  const [screenSession, setScreenSession] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await createAgent({
        projectId,
        name,
        screenSession,
      });
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="p-3 bg-gray-700/30 rounded-lg mt-2">
      <div className="flex gap-2 mb-2">
        <input
          type="text"
          placeholder="Agent name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 px-2 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-white
                     focus:outline-none focus:ring-1 focus:ring-primary-500"
          required
          autoFocus
        />
        <input
          type="text"
          placeholder="tmux session name"
          value={screenSession}
          onChange={(e) => setScreenSession(e.target.value)}
          className="flex-1 px-2 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-white
                     focus:outline-none focus:ring-1 focus:ring-primary-500"
        />
      </div>
      {error && <p className="text-red-400 text-xs mb-2">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={loading}
          className="px-3 py-1 bg-green-600 hover:bg-green-700 text-white text-sm rounded transition-colors disabled:opacity-50"
        >
          {loading ? 'Creating...' : 'Add Agent'}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1 bg-gray-600 hover:bg-gray-700 text-white text-sm rounded transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export default AddAgentForm;
