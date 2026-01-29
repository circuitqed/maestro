import React, { useState } from 'react';
import { useApp } from '../context/AppContext';

function LoginForm() {
  const { login, passwordRequired } = useApp();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await login(password);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-white mb-2">Maestro</h1>
          <p className="text-gray-400">Agent Orchestrator</p>
        </div>

        <form onSubmit={handleSubmit} className="bg-gray-800 rounded-lg p-6 shadow-xl">
          <h2 className="text-xl font-semibold text-white mb-4">
            {passwordRequired ? 'Login' : 'Set Password'}
          </h2>

          {!passwordRequired && (
            <p className="text-gray-400 text-sm mb-4">
              Set a password to secure your Maestro dashboard.
            </p>
          )}

          {error && (
            <div className="bg-red-900/50 border border-red-500 text-red-200 px-4 py-2 rounded mb-4">
              {error}
            </div>
          )}

          <div className="mb-4">
            <label htmlFor="password" className="block text-gray-300 text-sm font-medium mb-2">
              Password
            </label>
            <input
              type="password"
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded text-white
                         focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              placeholder={passwordRequired ? 'Enter password' : 'Choose a password'}
              required
              autoFocus
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 px-4 bg-primary-600 hover:bg-primary-700 text-white font-medium
                       rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Please wait...' : passwordRequired ? 'Login' : 'Set Password'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default LoginForm;
