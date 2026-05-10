import React, { useEffect, useState } from 'react';
import type { CommandResultDisplay } from 'src/commands.js';
import { logEvent } from 'src/services/analytics/index.js';
import { logForDebugging } from 'src/utils/debug.js';
import { Box, Text } from '../ink.js';
import { execFileNoThrow } from '../utils/execFileNoThrow.js';
import { getPlansDirectory } from '../utils/plans.js';
import { setCwd } from '../utils/Shell.js';
import { cleanupWorktree, getCurrentWorktreeSession, keepWorktree, killTmuxSession } from '../utils/worktree.js';
import { Select } from './CustomSelect/select.js';
import { Dialog } from './design-system/Dialog.js';
import { Spinner } from './Spinner.js';

// Inline require breaks the cycle this file would otherwise close:
// sessionStorage → commands → exit → ExitFlow → here. All call sites
// are inside callbacks, so the lazy require never sees an undefined import.
function recordWorktreeExit(): void {
  /* eslint-disable @typescript-eslint/no-require-imports */
  ;
  (require('../utils/sessionStorage.js') as typeof import('../utils/sessionStorage.js')).saveWorktreeState(null);
  /* eslint-enable @typescript-eslint/no-require-imports */
}
type Props = {
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  onCancel?: () => void;
};
export function WorktreeExitDialog({
  onDone,
  onCancel
}: Props): React.ReactNode {
  const [status, setStatus] = useState<'loading' | 'asking' | 'keeping' | 'removing' | 'done'>('loading');
  const [changes, setChanges] = useState<string[]>([]);
  const [commitCount, setCommitCount] = useState<number>(0);
  const [resultMessage, setResultMessage] = useState<string | undefined>();
  const worktreeSession = getCurrentWorktreeSession();
  useEffect(() => {
    async function loadChanges() {
      let changeLines: string[] = [];
      const gitStatus = await execFileNoThrow('git', ['status', '--porcelain']);
      if (gitStatus.stdout) {
        changeLines = gitStatus.stdout.split('\n').filter(_ => _.trim() !== '');
        setChanges(changeLines);
      }

      // Check for commits to eject
      if (worktreeSession) {
        // Get commits in worktree that are not in original branch
        const {
          stdout: commitsStr
        } = await execFileNoThrow('git', ['rev-list', '--count', `${worktreeSession.originalHeadCommit}..HEAD`]);
        const count = parseInt(commitsStr.trim()) || 0;
        setCommitCount(count);

        // If no changes and no commits, clean up silently
        if (changeLines.length === 0 && count === 0) {
          if (worktreeSession.deleteBranchOnRemove === false) {
            setStatus('keeping');
            void keepWorktree().then(() => {
              process.chdir(worktreeSession.originalCwd);
              setCwd(worktreeSession.originalCwd);
              recordWorktreeExit();
              getPlansDirectory.cache.clear?.();
              setResultMessage(`Existing worktree kept at ${worktreeSession.worktreePath}`);
            }).catch(error => {
              logForDebugging(`Failed to keep worktree: ${error}`, {
                level: 'error'
              });
              setResultMessage('Worktree keep failed, exiting anyway');
            }).then(() => {
              setStatus('done');
            });
            return;
          }
          setStatus('removing');
          void cleanupWorktree().then(() => {
            process.chdir(worktreeSession.originalCwd);
            setCwd(worktreeSession.originalCwd);
            recordWorktreeExit();
            getPlansDirectory.cache.clear?.();
            setResultMessage('Worktree removed (no changes)');
          }).catch(error => {
            logForDebugging(`Failed to clean up worktree: ${error}`, {
              level: 'error'
            });
            setResultMessage('Worktree cleanup failed, exiting anyway');
          }).then(() => {
            setStatus('done');
          });
          return;
        } else {
          setStatus('asking');
        }
      }
    }
    void loadChanges();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // biome-ignore lint/correctness/useExhaustiveDependencies: intentional
  }, [worktreeSession]);
  useEffect(() => {
    if (status === 'done') {
      onDone(resultMessage);
    }
  }, [status, onDone, resultMessage]);
  if (!worktreeSession) {
    onDone('No active worktree session found', {
      display: 'system'
    });
    return null;
  }
  if (status === 'loading' || status === 'done') {
    return null;
  }
  async function handleSelect(value: string) {
    if (!worktreeSession) return;
    const hasTmux = Boolean(worktreeSession.tmuxSessionName);
    if (value === 'keep' || value === 'keep-with-tmux') {
      setStatus('keeping');
      logEvent('tengu_worktree_kept', {
        commits: commitCount,
        changed_files: changes.length
      });
      await keepWorktree();
      process.chdir(worktreeSession.originalCwd);
      setCwd(worktreeSession.originalCwd);
      recordWorktreeExit();
      getPlansDirectory.cache.clear?.();
      if (hasTmux) {
        setResultMessage(`Worktree kept. Your work is saved at ${worktreeSession.worktreePath} on branch ${worktreeSession.worktreeBranch}. Reattach to tmux session with: tmux attach -t ${worktreeSession.tmuxSessionName}`);
      } else {
        setResultMessage(`Worktree kept. Your work is saved at ${worktreeSession.worktreePath} on branch ${worktreeSession.worktreeBranch}`);
      }
      setStatus('done');
    } else if (value === 'keep-kill-tmux') {
      setStatus('keeping');
      logEvent('tengu_worktree_kept', {
        commits: commitCount,
        changed_files: changes.length
      });
      if (worktreeSession.tmuxSessionName) {
        await killTmuxSession(worktreeSession.tmuxSessionName);
      }
      await keepWorktree();
      process.chdir(worktreeSession.originalCwd);
      setCwd(worktreeSession.originalCwd);
      recordWorktreeExit();
      getPlansDirectory.cache.clear?.();
      setResultMessage(`Worktree kept at ${worktreeSession.worktreePath} on branch ${worktreeSession.worktreeBranch}. Tmux session terminated.`);
      setStatus('done');
    } else if (value === 'remove' || value === 'remove-with-tmux') {
      if (worktreeSession.deleteBranchOnRemove === false) {
        setStatus('keeping');
        await keepWorktree();
        process.chdir(worktreeSession.originalCwd);
        setCwd(worktreeSession.originalCwd);
        recordWorktreeExit();
        getPlansDirectory.cache.clear?.();
        setResultMessage(`Existing worktree kept at ${worktreeSession.worktreePath}. Remove it manually outside Claude Code if needed.`);
        setStatus('done');
        return;
      }
      setStatus('removing');
      logEvent('tengu_worktree_removed', {
        commits: commitCount,
        changed_files: changes.length
      });
      if (worktreeSession.tmuxSessionName) {
        await killTmuxSession(worktreeSession.tmuxSessionName);
      }
      try {
        await cleanupWorktree();
        process.chdir(worktreeSession.originalCwd);
        setCwd(worktreeSession.originalCwd);
        recordWorktreeExit();
        getPlansDirectory.cache.clear?.();
      } catch (error) {
        logForDebugging(`Failed to clean up worktree: ${error}`, {
          level: 'error'
        });
        setResultMessage('Worktree cleanup failed, exiting anyway');
        setStatus('done');
        return;
      }
      const tmuxNote = hasTmux ? ' Tmux session terminated.' : '';
      if (commitCount > 0 && changes.length > 0) {
        setResultMessage(`Worktree removed. ${commitCount} ${commitCount === 1 ? 'commit' : 'commits'} and uncommitted changes were discarded.${tmuxNote}`);
      } else if (commitCount > 0) {
        setResultMessage(`Worktree removed. ${commitCount} ${commitCount === 1 ? 'commit' : 'commits'} on ${worktreeSession.worktreeBranch} ${commitCount === 1 ? 'was' : 'were'} discarded.${tmuxNote}`);
      } else if (changes.length > 0) {
        setResultMessage(`Worktree removed. Uncommitted changes were discarded.${tmuxNote}`);
      } else {
        setResultMessage(`Worktree removed.${tmuxNote}`);
      }
      setStatus('done');
    }
  }
  if (status === 'keeping') {
    return <Box flexDirection="row" marginY={1}>
        <Spinner />
        <Text>Keeping worktree…</Text>
      </Box>;
  }
  if (status === 'removing') {
    return <Box flexDirection="row" marginY={1}>
        <Spinner />
        <Text>Removing worktree…</Text>
      </Box>;
  }
  const branchName = worktreeSession.worktreeBranch;
  const hasUncommitted = changes.length > 0;
  const hasCommits = commitCount > 0;
  const canRemoveWorktree = worktreeSession.deleteBranchOnRemove !== false;
  let subtitle = '';
  if (!canRemoveWorktree) {
    subtitle = 'This existing worktree was entered by path. Claude Code will keep it; remove it manually outside Claude Code if needed.';
  } else if (hasUncommitted && hasCommits) {
    subtitle = `You have ${changes.length} uncommitted ${changes.length === 1 ? 'file' : 'files'} and ${commitCount} ${commitCount === 1 ? 'commit' : 'commits'} on ${branchName}. All will be lost if you remove.`;
  } else if (hasUncommitted) {
    subtitle = `You have ${changes.length} uncommitted ${changes.length === 1 ? 'file' : 'files'}. These will be lost if you remove the worktree.`;
  } else if (hasCommits) {
    subtitle = `You have ${commitCount} ${commitCount === 1 ? 'commit' : 'commits'} on ${branchName}. The branch will be deleted if you remove the worktree.`;
  } else {
    subtitle = 'You are working in a worktree. Keep it to continue working there, or remove it to clean up.';
  }
  function handleCancel() {
    if (onCancel) {
      // Abort exit and return to the session
      onCancel();
      return;
    }
    // Fallback: treat Escape as "keep" if no onCancel provided
    void handleSelect('keep');
  }
  const removeDescription = hasUncommitted || hasCommits ? 'All changes and commits will be lost.' : 'Clean up the worktree directory.';
  const hasTmuxSession = Boolean(worktreeSession.tmuxSessionName);
  const options = hasTmuxSession ? [{
    label: 'Keep worktree and tmux session',
    value: 'keep-with-tmux',
    description: `Stays at ${worktreeSession.worktreePath}. Reattach with: tmux attach -t ${worktreeSession.tmuxSessionName}`
  }, {
    label: 'Keep worktree, kill tmux session',
    value: 'keep-kill-tmux',
    description: `Keeps worktree at ${worktreeSession.worktreePath}, terminates tmux session.`
  }, ...(canRemoveWorktree ? [{
    label: 'Remove worktree and tmux session',
    value: 'remove-with-tmux',
    description: removeDescription
  }] : [])] : [{
    label: 'Keep worktree',
    value: 'keep',
    description: `Stays at ${worktreeSession.worktreePath}`
  }, ...(canRemoveWorktree ? [{
    label: 'Remove worktree',
    value: 'remove',
    description: removeDescription
  }] : [])];
  const defaultValue = hasTmuxSession ? 'keep-with-tmux' : 'keep';
  return <Dialog title="Exiting worktree session" subtitle={subtitle} onCancel={handleCancel}>
      <Select defaultFocusValue={defaultValue} options={options} onChange={handleSelect} />
    </Dialog>;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsInVzZUVmZmVjdCIsInVzZVN0YXRlIiwiQ29tbWFuZFJlc3VsdERpc3BsYXkiLCJsb2dFdmVudCIsImxvZ0ZvckRlYnVnZ2luZyIsIkJveCIsIlRleHQiLCJleGVjRmlsZU5vVGhyb3ciLCJnZXRQbGFuc0RpcmVjdG9yeSIsInNldEN3ZCIsImNsZWFudXBXb3JrdHJlZSIsImdldEN1cnJlbnRXb3JrdHJlZVNlc3Npb24iLCJrZWVwV29ya3RyZWUiLCJraWxsVG11eFNlc3Npb24iLCJTZWxlY3QiLCJEaWFsb2ciLCJTcGlubmVyIiwicmVjb3JkV29ya3RyZWVFeGl0IiwicmVxdWlyZSIsInNhdmVXb3JrdHJlZVN0YXRlIiwiUHJvcHMiLCJvbkRvbmUiLCJyZXN1bHQiLCJvcHRpb25zIiwiZGlzcGxheSIsIm9uQ2FuY2VsIiwiV29ya3RyZWVFeGl0RGlhbG9nIiwiUmVhY3ROb2RlIiwic3RhdHVzIiwic2V0U3RhdHVzIiwiY2hhbmdlcyIsInNldENoYW5nZXMiLCJjb21taXRDb3VudCIsInNldENvbW1pdENvdW50IiwicmVzdWx0TWVzc2FnZSIsInNldFJlc3VsdE1lc3NhZ2UiLCJ3b3JrdHJlZVNlc3Npb24iLCJsb2FkQ2hhbmdlcyIsImNoYW5nZUxpbmVzIiwiZ2l0U3RhdHVzIiwic3Rkb3V0Iiwic3BsaXQiLCJmaWx0ZXIiLCJfIiwidHJpbSIsImNvbW1pdHNTdHIiLCJvcmlnaW5hbEhlYWRDb21taXQiLCJjb3VudCIsInBhcnNlSW50IiwibGVuZ3RoIiwidGhlbiIsInByb2Nlc3MiLCJjaGRpciIsIm9yaWdpbmFsQ3dkIiwiY2FjaGUiLCJjbGVhciIsImNhdGNoIiwiZXJyb3IiLCJsZXZlbCIsImhhbmRsZVNlbGVjdCIsInZhbHVlIiwiaGFzVG11eCIsIkJvb2xlYW4iLCJ0bXV4U2Vzc2lvbk5hbWUiLCJjb21taXRzIiwiY2hhbmdlZF9maWxlcyIsIndvcmt0cmVlUGF0aCIsIndvcmt0cmVlQnJhbmNoIiwidG11eE5vdGUiLCJicmFuY2hOYW1lIiwiaGFzVW5jb21taXR0ZWQiLCJoYXNDb21taXRzIiwic3VidGl0bGUiLCJoYW5kbGVDYW5jZWwiLCJyZW1vdmVEZXNjcmlwdGlvbiIsImhhc1RtdXhTZXNzaW9uIiwibGFiZWwiLCJkZXNjcmlwdGlvbiIsImRlZmF1bHRWYWx1ZSJdLCJzb3VyY2VzIjpbIldvcmt0cmVlRXhpdERpYWxvZy50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IFJlYWN0LCB7IHVzZUVmZmVjdCwgdXNlU3RhdGUgfSBmcm9tICdyZWFjdCc7XG5pbXBvcnQgdHlwZSB7IENvbW1hbmRSZXN1bHREaXNwbGF5IH0gZnJvbSAnc3JjL2NvbW1hbmRzLmpzJztcbmltcG9ydCB7IGxvZ0V2ZW50IH0gZnJvbSAnc3JjL3NlcnZpY2VzL2FuYWx5dGljcy9pbmRleC5qcyc7XG5pbXBvcnQgeyBsb2dGb3JEZWJ1Z2dpbmcgfSBmcm9tICdzcmMvdXRpbHMvZGVidWcuanMnO1xuaW1wb3J0IHsgQm94LCBUZXh0IH0gZnJvbSAnLi4vaW5rLmpzJztcbmltcG9ydCB7IGV4ZWNGaWxlTm9UaHJvdyB9IGZyb20gJy4uL3V0aWxzL2V4ZWNGaWxlTm9UaHJvdy5qcyc7XG5pbXBvcnQgeyBnZXRQbGFuc0RpcmVjdG9yeSB9IGZyb20gJy4uL3V0aWxzL3BsYW5zLmpzJztcbmltcG9ydCB7IHNldEN3ZCB9IGZyb20gJy4uL3V0aWxzL1NoZWxsLmpzJztcbmltcG9ydCB7IGNsZWFudXBXb3JrdHJlZSwgZ2V0Q3VycmVudFdvcmt0cmVlU2Vzc2lvbiwga2VlcFdvcmt0cmVlLCBraWxsVG11eFNlc3Npb24gfSBmcm9tICcuLi91dGlscy93b3JrdHJlZS5qcyc7XG5pbXBvcnQgeyBTZWxlY3QgfSBmcm9tICcuL0N1c3RvbVNlbGVjdC9zZWxlY3QuanMnO1xuaW1wb3J0IHsgRGlhbG9nIH0gZnJvbSAnLi9kZXNpZ24tc3lzdGVtL0RpYWxvZy5qcyc7XG5pbXBvcnQgeyBTcGlubmVyIH0gZnJvbSAnLi9TcGlubmVyLmpzJztcblxuLy8gSW5saW5lIHJlcXVpcmUgYnJlYWtzIHRoZSBjeWNsZSB0aGlzIGZpbGUgd291bGQgb3RoZXJ3aXNlIGNsb3NlOlxuLy8gc2Vzc2lvblN0b3JhZ2UgXHUyMTkyIGNvbW1hbmRzIFx1MjE5MiBleGl0IFx1MjE5MiBFeGl0RmxvdyBcdTIxOTIgaGVyZS4gQWxsIGNhbGwgc2l0ZXNcbi8vIGFyZSBpbnNpZGUgY2FsbGJhY2tzLCBzbyB0aGUgbGF6eSByZXF1aXJlIG5ldmVyIHNlZXMgYW4gdW5kZWZpbmVkIGltcG9ydC5cbmZ1bmN0aW9uIHJlY29yZFdvcmt0cmVlRXhpdCgpOiB2b2lkIHtcbiAgLyogZXNsaW50LWRpc2FibGUgQHR5cGVzY3JpcHQtZXNsaW50L25vLXJlcXVpcmUtaW1wb3J0cyAqL1xuICA7XG4gIChyZXF1aXJlKCcuLi91dGlscy9zZXNzaW9uU3RvcmFnZS5qcycpIGFzIHR5cGVvZiBpbXBvcnQoJy4uL3V0aWxzL3Nlc3Npb25TdG9yYWdlLmpzJykpLnNhdmVXb3JrdHJlZVN0YXRlKG51bGwpO1xuICAvKiBlc2xpbnQtZW5hYmxlIEB0eXBlc2NyaXB0LWVzbGludC9uby1yZXF1aXJlLWltcG9ydHMgKi9cbn1cbnR5cGUgUHJvcHMgPSB7XG4gIG9uRG9uZTogKHJlc3VsdD86IHN0cmluZywgb3B0aW9ucz86IHtcbiAgICBkaXNwbGF5PzogQ29tbWFuZFJlc3VsdERpc3BsYXk7XG4gIH0pID0+IHZvaWQ7XG4gIG9uQ2FuY2VsPzogKCkgPT4gdm9pZDtcbn07XG5leHBvcnQgZnVuY3Rpb24gV29ya3RyZWVFeGl0RGlhbG9nKHtcbiAgb25Eb25lLFxuICBvbkNhbmNlbFxufTogUHJvcHMpOiBSZWFjdC5SZWFjdE5vZGUge1xuICBjb25zdCBbc3RhdHVzLCBzZXRTdGF0dXNdID0gdXNlU3RhdGU8J2xvYWRpbmcnIHwgJ2Fza2luZycgfCAna2VlcGluZycgfCAncmVtb3ZpbmcnIHwgJ2RvbmUnPignbG9hZGluZycpO1xuICBjb25zdCBbY2hhbmdlcywgc2V0Q2hhbmdlc10gPSB1c2VTdGF0ZTxzdHJpbmdbXT4oW10pO1xuICBjb25zdCBbY29tbWl0Q291bnQsIHNldENvbW1pdENvdW50XSA9IHVzZVN0YXRlPG51bWJlcj4oMCk7XG4gIGNvbnN0IFtyZXN1bHRNZXNzYWdlLCBzZXRSZXN1bHRNZXNzYWdlXSA9IHVzZVN0YXRlPHN0cmluZyB8IHVuZGVmaW5lZD4oKTtcbiAgY29uc3Qgd29ya3RyZWVTZXNzaW9uID0gZ2V0Q3VycmVudFdvcmt0cmVlU2Vzc2lvbigpO1xuICB1c2VFZmZlY3QoKCkgPT4ge1xuICAgIGFzeW5jIGZ1bmN0aW9uIGxvYWRDaGFuZ2VzKCkge1xuICAgICAgbGV0IGNoYW5nZUxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgY29uc3QgZ2l0U3RhdHVzID0gYXdhaXQgZXhlY0ZpbGVOb1Rocm93KCdnaXQnLCBbJ3N0YXR1cycsICctLXBvcmNlbGFpbiddKTtcbiAgICAgIGlmIChnaXRTdGF0dXMuc3Rkb3V0KSB7XG4gICAgICAgIGNoYW5nZUxpbmVzID0gZ2l0U3RhdHVzLnN0ZG91dC5zcGxpdCgnXFxuJykuZmlsdGVyKF8gPT4gXy50cmltKCkgIT09ICcnKTtcbiAgICAgICAgc2V0Q2hhbmdlcyhjaGFuZ2VMaW5lcyk7XG4gICAgICB9XG5cbiAgICAgIC8vIENoZWNrIGZvciBjb21taXRzIHRvIGVqZWN0XG4gICAgICBpZiAod29ya3RyZWVTZXNzaW9uKSB7XG4gICAgICAgIC8vIEdldCBjb21taXRzIGluIHdvcmt0cmVlIHRoYXQgYXJlIG5vdCBpbiBvcmlnaW5hbCBicmFuY2hcbiAgICAgICAgY29uc3Qge1xuICAgICAgICAgIHN0ZG91dDogY29tbWl0c1N0clxuICAgICAgICB9ID0gYXdhaXQgZXhlY0ZpbGVOb1Rocm93KCdnaXQnLCBbJ3Jldi1saXN0JywgJy0tY291bnQnLCBgJHt3b3JrdHJlZVNlc3Npb24ub3JpZ2luYWxIZWFkQ29tbWl0fS4uSEVBRGBdKTtcbiAgICAgICAgY29uc3QgY291bnQgPSBwYXJzZUludChjb21taXRzU3RyLnRyaW0oKSkgfHwgMDtcbiAgICAgICAgc2V0Q29tbWl0Q291bnQoY291bnQpO1xuXG4gICAgICAgIC8vIElmIG5vIGNoYW5nZXMgYW5kIG5vIGNvbW1pdHMsIGNsZWFuIHVwIHNpbGVudGx5XG4gICAgICAgIGlmIChjaGFuZ2VMaW5lcy5sZW5ndGggPT09IDAgJiYgY291bnQgPT09IDApIHtcbiAgICAgICAgICBpZiAod29ya3RyZWVTZXNzaW9uLmRlbGV0ZUJyYW5jaE9uUmVtb3ZlID09PSBmYWxzZSkge1xuICAgICAgICAgICAgc2V0U3RhdHVzKCdrZWVwaW5nJyk7XG4gICAgICAgICAgICB2b2lkIGtlZXBXb3JrdHJlZSgpLnRoZW4oKCkgPT4ge1xuICAgICAgICAgICAgICBwcm9jZXNzLmNoZGlyKHdvcmt0cmVlU2Vzc2lvbi5vcmlnaW5hbEN3ZCk7XG4gICAgICAgICAgICAgIHNldEN3ZCh3b3JrdHJlZVNlc3Npb24ub3JpZ2luYWxDd2QpO1xuICAgICAgICAgICAgICByZWNvcmRXb3JrdHJlZUV4aXQoKTtcbiAgICAgICAgICAgICAgZ2V0UGxhbnNEaXJlY3RvcnkuY2FjaGUuY2xlYXI/LigpO1xuICAgICAgICAgICAgICBzZXRSZXN1bHRNZXNzYWdlKGBFeGlzdGluZyB3b3JrdHJlZSBrZXB0IGF0ICR7d29ya3RyZWVTZXNzaW9uLndvcmt0cmVlUGF0aH1gKTtcbiAgICAgICAgICAgIH0pLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgICAgICAgbG9nRm9yRGVidWdnaW5nKGBGYWlsZWQgdG8ga2VlcCB3b3JrdHJlZTogJHtlcnJvcn1gLCB7XG4gICAgICAgICAgICAgICAgbGV2ZWw6ICdlcnJvcidcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgIHNldFJlc3VsdE1lc3NhZ2UoJ1dvcmt0cmVlIGtlZXAgZmFpbGVkLCBleGl0aW5nIGFueXdheScpO1xuICAgICAgICAgICAgfSkudGhlbigoKSA9PiB7XG4gICAgICAgICAgICAgIHNldFN0YXR1cygnZG9uZScpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIHNldFN0YXR1cygncmVtb3ZpbmcnKTtcbiAgICAgICAgICB2b2lkIGNsZWFudXBXb3JrdHJlZSgpLnRoZW4oKCkgPT4ge1xuICAgICAgICAgICAgcHJvY2Vzcy5jaGRpcih3b3JrdHJlZVNlc3Npb24ub3JpZ2luYWxDd2QpO1xuICAgICAgICAgICAgc2V0Q3dkKHdvcmt0cmVlU2Vzc2lvbi5vcmlnaW5hbEN3ZCk7XG4gICAgICAgICAgICByZWNvcmRXb3JrdHJlZUV4aXQoKTtcbiAgICAgICAgICAgIGdldFBsYW5zRGlyZWN0b3J5LmNhY2hlLmNsZWFyPy4oKTtcbiAgICAgICAgICAgIHNldFJlc3VsdE1lc3NhZ2UoJ1dvcmt0cmVlIHJlbW92ZWQgKG5vIGNoYW5nZXMpJyk7XG4gICAgICAgICAgfSkuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAgICAgbG9nRm9yRGVidWdnaW5nKGBGYWlsZWQgdG8gY2xlYW4gdXAgd29ya3RyZWU6ICR7ZXJyb3J9YCwge1xuICAgICAgICAgICAgICBsZXZlbDogJ2Vycm9yJ1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBzZXRSZXN1bHRNZXNzYWdlKCdXb3JrdHJlZSBjbGVhbnVwIGZhaWxlZCwgZXhpdGluZyBhbnl3YXknKTtcbiAgICAgICAgICB9KS50aGVuKCgpID0+IHtcbiAgICAgICAgICAgIHNldFN0YXR1cygnZG9uZScpO1xuICAgICAgICAgIH0pO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBzZXRTdGF0dXMoJ2Fza2luZycpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIHZvaWQgbG9hZENoYW5nZXMoKTtcbiAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgcmVhY3QtaG9va3MvZXhoYXVzdGl2ZS1kZXBzXG4gICAgLy8gYmlvbWUtaWdub3JlIGxpbnQvY29ycmVjdG5lc3MvdXNlRXhoYXVzdGl2ZURlcGVuZGVuY2llczogaW50ZW50aW9uYWxcbiAgfSwgW3dvcmt0cmVlU2Vzc2lvbl0pO1xuICB1c2VFZmZlY3QoKCkgPT4ge1xuICAgIGlmIChzdGF0dXMgPT09ICdkb25lJykge1xuICAgICAgb25Eb25lKHJlc3VsdE1lc3NhZ2UpO1xuICAgIH1cbiAgfSwgW3N0YXR1cywgb25Eb25lLCByZXN1bHRNZXNzYWdlXSk7XG4gIGlmICghd29ya3RyZWVTZXNzaW9uKSB7XG4gICAgb25Eb25lKCdObyBhY3RpdmUgd29ya3RyZWUgc2Vzc2lvbiBmb3VuZCcsIHtcbiAgICAgIGRpc3BsYXk6ICdzeXN0ZW0nXG4gICAgfSk7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgaWYgKHN0YXR1cyA9PT0gJ2xvYWRpbmcnIHx8IHN0YXR1cyA9PT0gJ2RvbmUnKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgYXN5bmMgZnVuY3Rpb24gaGFuZGxlU2VsZWN0KHZhbHVlOiBzdHJpbmcpIHtcbiAgICBpZiAoIXdvcmt0cmVlU2Vzc2lvbikgcmV0dXJuO1xuICAgIGNvbnN0IGhhc1RtdXggPSBCb29sZWFuKHdvcmt0cmVlU2Vzc2lvbi50bXV4U2Vzc2lvbk5hbWUpO1xuICAgIGlmICh2YWx1ZSA9PT0gJ2tlZXAnIHx8IHZhbHVlID09PSAna2VlcC13aXRoLXRtdXgnKSB7XG4gICAgICBzZXRTdGF0dXMoJ2tlZXBpbmcnKTtcbiAgICAgIGxvZ0V2ZW50KCd0ZW5ndV93b3JrdHJlZV9rZXB0Jywge1xuICAgICAgICBjb21taXRzOiBjb21taXRDb3VudCxcbiAgICAgICAgY2hhbmdlZF9maWxlczogY2hhbmdlcy5sZW5ndGhcbiAgICAgIH0pO1xuICAgICAgYXdhaXQga2VlcFdvcmt0cmVlKCk7XG4gICAgICBwcm9jZXNzLmNoZGlyKHdvcmt0cmVlU2Vzc2lvbi5vcmlnaW5hbEN3ZCk7XG4gICAgICBzZXRDd2Qod29ya3RyZWVTZXNzaW9uLm9yaWdpbmFsQ3dkKTtcbiAgICAgIHJlY29yZFdvcmt0cmVlRXhpdCgpO1xuICAgICAgZ2V0UGxhbnNEaXJlY3RvcnkuY2FjaGUuY2xlYXI/LigpO1xuICAgICAgaWYgKGhhc1RtdXgpIHtcbiAgICAgICAgc2V0UmVzdWx0TWVzc2FnZShgV29ya3RyZWUga2VwdC4gWW91ciB3b3JrIGlzIHNhdmVkIGF0ICR7d29ya3RyZWVTZXNzaW9uLndvcmt0cmVlUGF0aH0gb24gYnJhbmNoICR7d29ya3RyZWVTZXNzaW9uLndvcmt0cmVlQnJhbmNofS4gUmVhdHRhY2ggdG8gdG11eCBzZXNzaW9uIHdpdGg6IHRtdXggYXR0YWNoIC10ICR7d29ya3RyZWVTZXNzaW9uLnRtdXhTZXNzaW9uTmFtZX1gKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHNldFJlc3VsdE1lc3NhZ2UoYFdvcmt0cmVlIGtlcHQuIFlvdXIgd29yayBpcyBzYXZlZCBhdCAke3dvcmt0cmVlU2Vzc2lvbi53b3JrdHJlZVBhdGh9IG9uIGJyYW5jaCAke3dvcmt0cmVlU2Vzc2lvbi53b3JrdHJlZUJyYW5jaH1gKTtcbiAgICAgIH1cbiAgICAgIHNldFN0YXR1cygnZG9uZScpO1xuICAgIH0gZWxzZSBpZiAodmFsdWUgPT09ICdrZWVwLWtpbGwtdG11eCcpIHtcbiAgICAgIHNldFN0YXR1cygna2VlcGluZycpO1xuICAgICAgbG9nRXZlbnQoJ3Rlbmd1X3dvcmt0cmVlX2tlcHQnLCB7XG4gICAgICAgIGNvbW1pdHM6IGNvbW1pdENvdW50LFxuICAgICAgICBjaGFuZ2VkX2ZpbGVzOiBjaGFuZ2VzLmxlbmd0aFxuICAgICAgfSk7XG4gICAgICBpZiAod29ya3RyZWVTZXNzaW9uLnRtdXhTZXNzaW9uTmFtZSkge1xuICAgICAgICBhd2FpdCBraWxsVG11eFNlc3Npb24od29ya3RyZWVTZXNzaW9uLnRtdXhTZXNzaW9uTmFtZSk7XG4gICAgICB9XG4gICAgICBhd2FpdCBrZWVwV29ya3RyZWUoKTtcbiAgICAgIHByb2Nlc3MuY2hkaXIod29ya3RyZWVTZXNzaW9uLm9yaWdpbmFsQ3dkKTtcbiAgICAgIHNldEN3ZCh3b3JrdHJlZVNlc3Npb24ub3JpZ2luYWxDd2QpO1xuICAgICAgcmVjb3JkV29ya3RyZWVFeGl0KCk7XG4gICAgICBnZXRQbGFuc0RpcmVjdG9yeS5jYWNoZS5jbGVhcj8uKCk7XG4gICAgICBzZXRSZXN1bHRNZXNzYWdlKGBXb3JrdHJlZSBrZXB0IGF0ICR7d29ya3RyZWVTZXNzaW9uLndvcmt0cmVlUGF0aH0gb24gYnJhbmNoICR7d29ya3RyZWVTZXNzaW9uLndvcmt0cmVlQnJhbmNofS4gVG11eCBzZXNzaW9uIHRlcm1pbmF0ZWQuYCk7XG4gICAgICBzZXRTdGF0dXMoJ2RvbmUnKTtcbiAgICB9IGVsc2UgaWYgKHZhbHVlID09PSAncmVtb3ZlJyB8fCB2YWx1ZSA9PT0gJ3JlbW92ZS13aXRoLXRtdXgnKSB7XG4gICAgICBpZiAod29ya3RyZWVTZXNzaW9uLmRlbGV0ZUJyYW5jaE9uUmVtb3ZlID09PSBmYWxzZSkge1xuICAgICAgICBzZXRTdGF0dXMoJ2tlZXBpbmcnKTtcbiAgICAgICAgYXdhaXQga2VlcFdvcmt0cmVlKCk7XG4gICAgICAgIHByb2Nlc3MuY2hkaXIod29ya3RyZWVTZXNzaW9uLm9yaWdpbmFsQ3dkKTtcbiAgICAgICAgc2V0Q3dkKHdvcmt0cmVlU2Vzc2lvbi5vcmlnaW5hbEN3ZCk7XG4gICAgICAgIHJlY29yZFdvcmt0cmVlRXhpdCgpO1xuICAgICAgICBnZXRQbGFuc0RpcmVjdG9yeS5jYWNoZS5jbGVhcj8uKCk7XG4gICAgICAgIHNldFJlc3VsdE1lc3NhZ2UoYEV4aXN0aW5nIHdvcmt0cmVlIGtlcHQgYXQgJHt3b3JrdHJlZVNlc3Npb24ud29ya3RyZWVQYXRofS4gUmVtb3ZlIGl0IG1hbnVhbGx5IG91dHNpZGUgQ2xhdWRlIENvZGUgaWYgbmVlZGVkLmApO1xuICAgICAgICBzZXRTdGF0dXMoJ2RvbmUnKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgc2V0U3RhdHVzKCdyZW1vdmluZycpO1xuICAgICAgbG9nRXZlbnQoJ3Rlbmd1X3dvcmt0cmVlX3JlbW92ZWQnLCB7XG4gICAgICAgIGNvbW1pdHM6IGNvbW1pdENvdW50LFxuICAgICAgICBjaGFuZ2VkX2ZpbGVzOiBjaGFuZ2VzLmxlbmd0aFxuICAgICAgfSk7XG4gICAgICBpZiAod29ya3RyZWVTZXNzaW9uLnRtdXhTZXNzaW9uTmFtZSkge1xuICAgICAgICBhd2FpdCBraWxsVG11eFNlc3Npb24od29ya3RyZWVTZXNzaW9uLnRtdXhTZXNzaW9uTmFtZSk7XG4gICAgICB9XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBjbGVhbnVwV29ya3RyZWUoKTtcbiAgICAgICAgcHJvY2Vzcy5jaGRpcih3b3JrdHJlZVNlc3Npb24ub3JpZ2luYWxDd2QpO1xuICAgICAgICBzZXRDd2Qod29ya3RyZWVTZXNzaW9uLm9yaWdpbmFsQ3dkKTtcbiAgICAgICAgcmVjb3JkV29ya3RyZWVFeGl0KCk7XG4gICAgICAgIGdldFBsYW5zRGlyZWN0b3J5LmNhY2hlLmNsZWFyPy4oKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGxvZ0ZvckRlYnVnZ2luZyhgRmFpbGVkIHRvIGNsZWFuIHVwIHdvcmt0cmVlOiAke2Vycm9yfWAsIHtcbiAgICAgICAgICBsZXZlbDogJ2Vycm9yJ1xuICAgICAgICB9KTtcbiAgICAgICAgc2V0UmVzdWx0TWVzc2FnZSgnV29ya3RyZWUgY2xlYW51cCBmYWlsZWQsIGV4aXRpbmcgYW55d2F5Jyk7XG4gICAgICAgIHNldFN0YXR1cygnZG9uZScpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjb25zdCB0bXV4Tm90ZSA9IGhhc1RtdXggPyAnIFRtdXggc2Vzc2lvbiB0ZXJtaW5hdGVkLicgOiAnJztcbiAgICAgIGlmIChjb21taXRDb3VudCA+IDAgJiYgY2hhbmdlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIHNldFJlc3VsdE1lc3NhZ2UoYFdvcmt0cmVlIHJlbW92ZWQuICR7Y29tbWl0Q291bnR9ICR7Y29tbWl0Q291bnQgPT09IDEgPyAnY29tbWl0JyA6ICdjb21taXRzJ30gYW5kIHVuY29tbWl0dGVkIGNoYW5nZXMgd2VyZSBkaXNjYXJkZWQuJHt0bXV4Tm90ZX1gKTtcbiAgICAgIH0gZWxzZSBpZiAoY29tbWl0Q291bnQgPiAwKSB7XG4gICAgICAgIHNldFJlc3VsdE1lc3NhZ2UoYFdvcmt0cmVlIHJlbW92ZWQuICR7Y29tbWl0Q291bnR9ICR7Y29tbWl0Q291bnQgPT09IDEgPyAnY29tbWl0JyA6ICdjb21taXRzJ30gb24gJHt3b3JrdHJlZVNlc3Npb24ud29ya3RyZWVCcmFuY2h9ICR7Y29tbWl0Q291bnQgPT09IDEgPyAnd2FzJyA6ICd3ZXJlJ30gZGlzY2FyZGVkLiR7dG11eE5vdGV9YCk7XG4gICAgICB9IGVsc2UgaWYgKGNoYW5nZXMubGVuZ3RoID4gMCkge1xuICAgICAgICBzZXRSZXN1bHRNZXNzYWdlKGBXb3JrdHJlZSByZW1vdmVkLiBVbmNvbW1pdHRlZCBjaGFuZ2VzIHdlcmUgZGlzY2FyZGVkLiR7dG11eE5vdGV9YCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzZXRSZXN1bHRNZXNzYWdlKGBXb3JrdHJlZSByZW1vdmVkLiR7dG11eE5vdGV9YCk7XG4gICAgICB9XG4gICAgICBzZXRTdGF0dXMoJ2RvbmUnKTtcbiAgICB9XG4gIH1cbiAgaWYgKHN0YXR1cyA9PT0gJ2tlZXBpbmcnKSB7XG4gICAgcmV0dXJuIDxCb3ggZmxleERpcmVjdGlvbj1cInJvd1wiIG1hcmdpblk9ezF9PlxuICAgICAgICA8U3Bpbm5lciAvPlxuICAgICAgICA8VGV4dD5LZWVwaW5nIHdvcmt0cmVlXHUyMDI2PC9UZXh0PlxuICAgICAgPC9Cb3g+O1xuICB9XG4gIGlmIChzdGF0dXMgPT09ICdyZW1vdmluZycpIHtcbiAgICByZXR1cm4gPEJveCBmbGV4RGlyZWN0aW9uPVwicm93XCIgbWFyZ2luWT17MX0+XG4gICAgICAgIDxTcGlubmVyIC8+XG4gICAgICAgIDxUZXh0PlJlbW92aW5nIHdvcmt0cmVlXHUyMDI2PC9UZXh0PlxuICAgICAgPC9Cb3g+O1xuICB9XG4gIGNvbnN0IGJyYW5jaE5hbWUgPSB3b3JrdHJlZVNlc3Npb24ud29ya3RyZWVCcmFuY2g7XG4gIGNvbnN0IGhhc1VuY29tbWl0dGVkID0gY2hhbmdlcy5sZW5ndGggPiAwO1xuICBjb25zdCBoYXNDb21taXRzID0gY29tbWl0Q291bnQgPiAwO1xuICBjb25zdCBjYW5SZW1vdmVXb3JrdHJlZSA9IHdvcmt0cmVlU2Vzc2lvbi5kZWxldGVCcmFuY2hPblJlbW92ZSAhPT0gZmFsc2U7XG4gIGxldCBzdWJ0aXRsZSA9ICcnO1xuICBpZiAoIWNhblJlbW92ZVdvcmt0cmVlKSB7XG4gICAgc3VidGl0bGUgPSAnVGhpcyBleGlzdGluZyB3b3JrdHJlZSB3YXMgZW50ZXJlZCBieSBwYXRoLiBDbGF1ZGUgQ29kZSB3aWxsIGtlZXAgaXQ7IHJlbW92ZSBpdCBtYW51YWxseSBvdXRzaWRlIENsYXVkZSBDb2RlIGlmIG5lZWRlZC4nO1xuICB9IGVsc2UgaWYgKGhhc1VuY29tbWl0dGVkICYmIGhhc0NvbW1pdHMpIHtcbiAgICBzdWJ0aXRsZSA9IGBZb3UgaGF2ZSAke2NoYW5nZXMubGVuZ3RofSB1bmNvbW1pdHRlZCAke2NoYW5nZXMubGVuZ3RoID09PSAxID8gJ2ZpbGUnIDogJ2ZpbGVzJ30gYW5kICR7Y29tbWl0Q291bnR9ICR7Y29tbWl0Q291bnQgPT09IDEgPyAnY29tbWl0JyA6ICdjb21taXRzJ30gb24gJHticmFuY2hOYW1lfS4gQWxsIHdpbGwgYmUgbG9zdCBpZiB5b3UgcmVtb3ZlLmA7XG4gIH0gZWxzZSBpZiAoaGFzVW5jb21taXR0ZWQpIHtcbiAgICBzdWJ0aXRsZSA9IGBZb3UgaGF2ZSAke2NoYW5nZXMubGVuZ3RofSB1bmNvbW1pdHRlZCAke2NoYW5nZXMubGVuZ3RoID09PSAxID8gJ2ZpbGUnIDogJ2ZpbGVzJ30uIFRoZXNlIHdpbGwgYmUgbG9zdCBpZiB5b3UgcmVtb3ZlIHRoZSB3b3JrdHJlZS5gO1xuICB9IGVsc2UgaWYgKGhhc0NvbW1pdHMpIHtcbiAgICBzdWJ0aXRsZSA9IGBZb3UgaGF2ZSAke2NvbW1pdENvdW50fSAke2NvbW1pdENvdW50ID09PSAxID8gJ2NvbW1pdCcgOiAnY29tbWl0cyd9IG9uICR7YnJhbmNoTmFtZX0uIFRoZSBicmFuY2ggd2lsbCBiZSBkZWxldGVkIGlmIHlvdSByZW1vdmUgdGhlIHdvcmt0cmVlLmA7XG4gIH0gZWxzZSB7XG4gICAgc3VidGl0bGUgPSAnWW91IGFyZSB3b3JraW5nIGluIGEgd29ya3RyZWUuIEtlZXAgaXQgdG8gY29udGludWUgd29ya2luZyB0aGVyZSwgb3IgcmVtb3ZlIGl0IHRvIGNsZWFuIHVwLic7XG4gIH1cbiAgZnVuY3Rpb24gaGFuZGxlQ2FuY2VsKCkge1xuICAgIGlmIChvbkNhbmNlbCkge1xuICAgICAgLy8gQWJvcnQgZXhpdCBhbmQgcmV0dXJuIHRvIHRoZSBzZXNzaW9uXG4gICAgICBvbkNhbmNlbCgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICAvLyBGYWxsYmFjazogdHJlYXQgRXNjYXBlIGFzIFwia2VlcFwiIGlmIG5vIG9uQ2FuY2VsIHByb3ZpZGVkXG4gICAgdm9pZCBoYW5kbGVTZWxlY3QoJ2tlZXAnKTtcbiAgfVxuICBjb25zdCByZW1vdmVEZXNjcmlwdGlvbiA9IGhhc1VuY29tbWl0dGVkIHx8IGhhc0NvbW1pdHMgPyAnQWxsIGNoYW5nZXMgYW5kIGNvbW1pdHMgd2lsbCBiZSBsb3N0LicgOiAnQ2xlYW4gdXAgdGhlIHdvcmt0cmVlIGRpcmVjdG9yeS4nO1xuICBjb25zdCBoYXNUbXV4U2Vzc2lvbiA9IEJvb2xlYW4od29ya3RyZWVTZXNzaW9uLnRtdXhTZXNzaW9uTmFtZSk7XG4gIGNvbnN0IG9wdGlvbnMgPSBoYXNUbXV4U2Vzc2lvbiA/IFt7XG4gICAgbGFiZWw6ICdLZWVwIHdvcmt0cmVlIGFuZCB0bXV4IHNlc3Npb24nLFxuICAgIHZhbHVlOiAna2VlcC13aXRoLXRtdXgnLFxuICAgIGRlc2NyaXB0aW9uOiBgU3RheXMgYXQgJHt3b3JrdHJlZVNlc3Npb24ud29ya3RyZWVQYXRofS4gUmVhdHRhY2ggd2l0aDogdG11eCBhdHRhY2ggLXQgJHt3b3JrdHJlZVNlc3Npb24udG11eFNlc3Npb25OYW1lfWBcbiAgfSwge1xuICAgIGxhYmVsOiAnS2VlcCB3b3JrdHJlZSwga2lsbCB0bXV4IHNlc3Npb24nLFxuICAgIHZhbHVlOiAna2VlcC1raWxsLXRtdXgnLFxuICAgIGRlc2NyaXB0aW9uOiBgS2VlcHMgd29ya3RyZWUgYXQgJHt3b3JrdHJlZVNlc3Npb24ud29ya3RyZWVQYXRofSwgdGVybWluYXRlcyB0bXV4IHNlc3Npb24uYFxuICB9LCAuLi4oY2FuUmVtb3ZlV29ya3RyZWUgPyBbe1xuICAgIGxhYmVsOiAnUmVtb3ZlIHdvcmt0cmVlIGFuZCB0bXV4IHNlc3Npb24nLFxuICAgIHZhbHVlOiAncmVtb3ZlLXdpdGgtdG11eCcsXG4gICAgZGVzY3JpcHRpb246IHJlbW92ZURlc2NyaXB0aW9uXG4gIH1dIDogW10pXSA6IFt7XG4gICAgbGFiZWw6ICdLZWVwIHdvcmt0cmVlJyxcbiAgICB2YWx1ZTogJ2tlZXAnLFxuICAgIGRlc2NyaXB0aW9uOiBgU3RheXMgYXQgJHt3b3JrdHJlZVNlc3Npb24ud29ya3RyZWVQYXRofWBcbiAgfSwgLi4uKGNhblJlbW92ZVdvcmt0cmVlID8gW3tcbiAgICBsYWJlbDogJ1JlbW92ZSB3b3JrdHJlZScsXG4gICAgdmFsdWU6ICdyZW1vdmUnLFxuICAgIGRlc2NyaXB0aW9uOiByZW1vdmVEZXNjcmlwdGlvblxuICB9XSA6IFtdKV07XG4gIGNvbnN0IGRlZmF1bHRWYWx1ZSA9IGhhc1RtdXhTZXNzaW9uID8gJ2tlZXAtd2l0aC10bXV4JyA6ICdrZWVwJztcbiAgcmV0dXJuIDxEaWFsb2cgdGl0bGU9XCJFeGl0aW5nIHdvcmt0cmVlIHNlc3Npb25cIiBzdWJ0aXRsZT17c3VidGl0bGV9IG9uQ2FuY2VsPXtoYW5kbGVDYW5jZWx9PlxuICAgICAgPFNlbGVjdCBkZWZhdWx0Rm9jdXNWYWx1ZT17ZGVmYXVsdFZhbHVlfSBvcHRpb25zPXtvcHRpb25zfSBvbkNoYW5nZT17aGFuZGxlU2VsZWN0fSAvPlxuICAgIDwvRGlhbG9n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