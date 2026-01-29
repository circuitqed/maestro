import React from 'react';
import { AppProvider, useApp } from './context/AppContext';
import LoginForm from './components/LoginForm';
import Layout from './components/Layout';

function AppContent() {
  const { authenticated, loading } = useApp();

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary-500 mx-auto mb-4"></div>
          <p className="text-gray-400">Loading...</p>
        </div>
      </div>
    );
  }

  if (!authenticated) {
    return <LoginForm />;
  }

  return <Layout />;
}

function App() {
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
}

export default App;
