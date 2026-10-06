import type { ClmBoard } from '../types'

// The `/clm board` pane's drawing: every repository's issues as four columns.
// It only draws; register.ts owns the state and passes the button actions in,
// since `$` never crosses an import.

const COLUMNS = [['todo', 'To do'], ['doing', 'Doing'], ['done', 'Done'], ['question', 'Question']] as const
const PER_COLUMN = 30

export const shortRepo = (repo: string) => repo.split('/').slice(-2).join('/')

type Els = { Box: any; Text: any; Button: any }
type Actions = { filter: (f: ClmBoard['filter']) => unknown; refresh: () => unknown }

export function BoardView({ Box, Text, Button }: Els, b: ClmBoard, columns: number, act: Actions) {
  const shown = b.filter === 'all' ? b.issues : b.issues.filter(i => i.repo === b.repo)
  const width = Math.max(12, Math.floor((columns - 3) / COLUMNS.length))
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Button key="repo" variant={b.filter === 'repo' ? 'primary' : undefined} onPress={() => act.filter('repo')}>{shortRepo(b.repo) || 'this repo'}</Button>
        <Button key="all" variant={b.filter === 'all' ? 'primary' : undefined} onPress={() => act.filter('all')}>all repos</Button>
        <Button key="refresh" onPress={() => act.refresh()}>refresh</Button>
      </Box>
      <Box flexDirection="row" gap={1}>
        {COLUMNS.map(([status, label]) => {
          const items = shown.filter(i => i.status === status).sort((x, y) => (x.updated < y.updated ? 1 : -1))
          return (
            <Box key={status} flexDirection="column" width={width}>
              <Text bold>{label} ({items.length})</Text>
              {items.length === 0 && <Text dimColor>-</Text>}
              {items.slice(0, PER_COLUMN).map(i => (
                <Text key={i.id} wrap="truncate-end">
                  {i.title} <Text dimColor>{i.id}{b.filter === 'all' ? ` ${shortRepo(i.repo)}` : ''}</Text>
                </Text>
              ))}
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}
