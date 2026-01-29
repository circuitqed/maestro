import React, { useState } from 'react';
import AgentRow from './AgentRow';
import ProjectSettings from './ProjectSettings';
import AddAgentForm from './AddAgentForm';

// Git branch icon
function GitIcon({ className }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 16 16">
      <path d="M11.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-2.25.75a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.492 2.492 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25zM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM3.5 3.25a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0z"/>
    </svg>
  );
}

// GitHub icon
function GitHubIcon({ className }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 16 16">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
    </svg>
  );
}

function ProjectCard({ project, agents }) {
  const [expanded, setExpanded] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAddAgent, setShowAddAgent] = useState(false);

  const busyCount = agents.filter((a) => a.status === 'running' || a.status === 'busy').length;
  const idleCount = agents.filter((a) => a.status === 'idle').length;

  const git = project.git;

  return (
    <div
      className="bg-gray-800 rounded-lg border-l-4 transition-colors"
      style={{ borderLeftColor: project.color }}
    >
      {/* Project Header */}
      <div className={expanded ? 'p-4' : 'px-4 py-3'}>
        <div className="flex items-center justify-between gap-3">
          {/* Expand/Collapse toggle */}
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-1 text-gray-400 hover:text-white transition-colors flex-shrink-0"
          >
            <svg
              className={`w-4 h-4 transition-transform ${expanded ? 'rotate-90' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>

          {/* Collapsed view: title + description inline */}
          {!expanded ? (
            <div className="flex-1 min-w-0 flex items-center gap-3">
              <h3 className="font-semibold text-white truncate">{project.name}</h3>
              {/* Git indicator (collapsed) */}
              {git && (
                git.githubUrl ? (
                  <a
                    href={git.githubUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-gray-500 hover:text-gray-300 transition-colors"
                    title={`${git.branch}${git.hasChanges ? ' (modified)' : ''}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <GitHubIcon className="w-3.5 h-3.5" />
                    {git.hasChanges && <span className="w-1.5 h-1.5 bg-yellow-500 rounded-full"></span>}
                  </a>
                ) : (
                  <span className="flex items-center gap-1 text-gray-600" title={git.branch}>
                    <GitIcon className="w-3.5 h-3.5" />
                    {git.hasChanges && <span className="w-1.5 h-1.5 bg-yellow-500 rounded-full"></span>}
                  </span>
                )
              )}
              {project.description && (
                <span className="text-gray-500 text-sm truncate hidden sm:inline">{project.description}</span>
              )}
              {/* Status badges */}
              <div className="flex items-center gap-2 ml-auto flex-shrink-0">
                <span className="text-gray-500 text-xs">{agents.length}</span>
                {busyCount > 0 && (
                  <span className="flex items-center gap-1 text-blue-400 text-xs">
                    <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse"></span>
                    {busyCount}
                  </span>
                )}
                {idleCount > 0 && (
                  <span className="flex items-center gap-1 text-green-400 text-xs">
                    <span className="w-1.5 h-1.5 bg-green-400 rounded-full"></span>
                    {idleCount}
                  </span>
                )}
              </div>
            </div>
          ) : (
            /* Expanded view: full details */
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-white truncate">{project.name}</h3>
                {/* Git indicator (expanded) */}
                {git && (
                  git.githubUrl ? (
                    <a
                      href={git.githubUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 px-2 py-0.5 bg-gray-700/50 rounded text-xs text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <GitHubIcon className="w-3.5 h-3.5" />
                      <span className="font-mono">{git.branch}</span>
                      {git.hasChanges && <span className="w-1.5 h-1.5 bg-yellow-500 rounded-full" title="Uncommitted changes"></span>}
                    </a>
                  ) : (
                    <span className="flex items-center gap-1.5 px-2 py-0.5 bg-gray-700/50 rounded text-xs text-gray-500">
                      <GitIcon className="w-3.5 h-3.5" />
                      <span className="font-mono">{git.branch}</span>
                      {git.hasChanges && <span className="w-1.5 h-1.5 bg-yellow-500 rounded-full" title="Uncommitted changes"></span>}
                    </span>
                  )
                )}
              </div>
              {project.description && (
                <p className="text-gray-400 text-sm mt-1 line-clamp-2">{project.description}</p>
              )}
              {project.path && (
                <p className="text-gray-500 text-xs font-mono truncate mt-1">{project.path}</p>
              )}

              {/* Status summary */}
              <div className="flex items-center gap-3 mt-2 text-sm">
                <span className="text-gray-400">{agents.length} agent{agents.length !== 1 ? 's' : ''}</span>
                {busyCount > 0 && (
                  <span className="flex items-center gap-1 text-blue-400">
                    <span className="w-2 h-2 bg-blue-400 rounded-full animate-pulse"></span>
                    {busyCount} busy
                  </span>
                )}
                {idleCount > 0 && (
                  <span className="flex items-center gap-1 text-green-400">
                    <span className="w-2 h-2 bg-green-400 rounded-full"></span>
                    {idleCount} ready
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-1 flex-shrink-0">
            {/* Add agent button */}
            <button
              onClick={() => {
                setExpanded(true);
                setShowAddAgent(!showAddAgent);
              }}
              className="p-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
              title="Add agent"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>

            {/* Settings button */}
            <div className="relative">
              <button
                onClick={() => setShowSettings(!showSettings)}
                className="p-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
                title="Project settings"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </button>

              {showSettings && (
                <ProjectSettings project={project} onClose={() => setShowSettings(false)} />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Expanded content - Agents */}
      {expanded && (
        <div className="px-4 pb-4">
          {/* Add agent form */}
          {showAddAgent && (
            <AddAgentForm projectId={project.id} onClose={() => setShowAddAgent(false)} />
          )}

          {/* Agent list */}
          {agents.length > 0 && (
            <div className="space-y-2 mt-2">
              {agents.map((agent) => (
                <AgentRow key={agent.id} agent={agent} />
              ))}
            </div>
          )}

          {agents.length === 0 && !showAddAgent && (
            <div className="text-center py-4 text-gray-500 text-sm">
              No agents yet.{' '}
              <button
                onClick={() => setShowAddAgent(true)}
                className="text-primary-400 hover:text-primary-300"
              >
                Add one
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default ProjectCard;
