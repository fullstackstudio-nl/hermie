/**
 * Settings ▸ Gateway ▸ Logs.
 *
 * A tail with a level filter, a component filter, a search and a copy, over the
 * one surface that exists: `GET /api/logs`. There is no socket method for logs
 * and no stream behind that route, so Follow is a POLL and the page says so —
 * see `logs-controller.ts` for why nothing here scrapes instead.
 *
 * A gateway with no such route gets the command rather than an empty page. It
 * is the same shape the memory browser uses for a gateway without the plugin:
 * name the thing that would work, on the machine where it would work.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'

import { useGateway } from '../../gateway'
import { copyToClipboard } from '../../platform/clipboard'
import { directTouchPanRef } from '../../platform/pointer-drag'
import { Button, InsetGroup, InsetRow, Screen, Text, TextField } from '../../ui/primitives'
import { FORM_MAX_WIDTH } from '../../ui/tokens'
import { useTheme } from '../../ui/theme'
import { ScreenHeader } from '../cron/ScreenHeader'
import {
  LOG_COMPONENTS,
  LOG_FILES,
  LOG_LEVELS,
  LOG_POLL_INTERVAL_MS,
  LogsController,
  LogsShapeError,
  LogsUnavailable,
  type LogComponent,
  type LogFile,
  type LogLevel,
  type LogPage
} from './logs-controller'
import { logStrings } from './strings'

export interface LogsScreenProps {
  onClose: () => void
}

export function LogsScreen({ onClose }: LogsScreenProps) {
  const theme = useTheme()
  const { http } = useGateway()

  const [file, setFile] = useState<LogFile>('gateway')
  const [level, setLevel] = useState<LogLevel | null>(null)
  const [component, setComponent] = useState<LogComponent | null>(null)
  const [search, setSearch] = useState('')
  const [following, setFollowing] = useState(true)
  const [page, setPage] = useState<LogPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [absent, setAbsent] = useState(false)
  /** What the route answered, when it answered something that is not a log page. */
  const [unreadable, setUnreadable] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const controller = useMemo(() => (http ? new LogsController(http) : null), [http])

  /*
    The search box drives the QUERY, not a filter over what is on screen: the
    route does the substring itself, over a 2000-line pre-filter window rather
    than the 500 it would otherwise read. Filtering locally would search only
    the tail the page happens to be holding and would quietly find less.
  */
  const read = useCallback(async () => {
    if (!controller) {
      return
    }

    try {
      setPage(await controller.read({ file, level, component, search }))
      setError(null)
      setAbsent(false)
      setUnreadable(null)
    } catch (cause) {
      if (cause instanceof LogsUnavailable) {
        setAbsent(true)
        setPage(null)
        setUnreadable(null)
      } else if (cause instanceof LogsShapeError) {
        /*
          The route answered and this app did not understand it. That is not an
          empty file and it is not a dead route, so it gets a state of its own
          — the one the owner's gateway needed, where the page said "This log is
          empty" about a reply it had thrown away.
        */
        setUnreadable(cause.saw)
        setPage(null)
        setError(null)
      } else {
        /*
          `hint` is FastAPI's own `detail`, which `GatewayHttp` parks on the
          error and this page used to drop: a 400 reading "Unknown log file:
          desktop" arrived as "failed with HTTP 400" and the actionable half was
          thrown away between the two.
        */
        const hint = (cause as { hint?: unknown } | null)?.hint

        setError(
          [cause instanceof Error ? cause.message : String(cause), typeof hint === 'string' ? hint : null]
            .filter(part => part !== null)
            .join(' ')
        )
      }
    }
  }, [controller, file, level, component, search])

  useEffect(() => {
    void read()
  }, [read])

  /*
    Following re-asks on a timer. It stops the moment the route turns out not to
    exist: polling a 404 every three seconds would be a request loop nobody
    asked for against a gateway that has already answered the question.
  */
  const readRef = useRef(read)
  readRef.current = read

  useEffect(() => {
    if (!following || absent || unreadable !== null) {
      return
    }

    const timer = setInterval(() => void readRef.current(), LOG_POLL_INTERVAL_MS)

    return () => clearInterval(timer)
  }, [following, absent, unreadable])

  const body = page?.lines ?? []

  return (
    <Screen edgeToEdgeTop padded={false}>
      <ScreenHeader back={logStrings.back} onBack={onClose} title={logStrings.title} />

      <ScrollView
        contentContainerStyle={{
          alignSelf: 'center',
          gap: theme.space.lg,
          maxWidth: FORM_MAX_WIDTH,
          padding: theme.space.lg,
          width: '100%'
        }}
        ref={directTouchPanRef}
      >
        {absent ? (
          /*
            The honest dead end. The route is the only way a client can read
            these files, so the page names the command instead of pretending
            there is nothing to see.
          */
          <InsetGroup
            footer={
              <Text color="textMuted" variant="meta">
                {logStrings.absentHint}
              </Text>
            }
          >
            <InsetRow>
              <Text color="textMuted" testID="logs-absent">
                {logStrings.absent}
              </Text>
            </InsetRow>
            <InsetRow>
              <Text testID="logs-command" variant="code">
                {logStrings.command}
              </Text>
            </InsetRow>
          </InsetGroup>
        ) : (
          <>
            <Chips
              current={file}
              label={logStrings.file}
              onSelect={next => setFile(next)}
              options={LOG_FILES.map(name => ({ label: logStrings.files[name], value: name }))}
              testID="logs-file"
            />

            <Chips
              current={level}
              label={logStrings.level}
              onSelect={next => setLevel(next)}
              options={[
                { label: logStrings.levelAll, value: null },
                ...LOG_LEVELS.map(name => ({ label: name, value: name }))
              ]}
              testID="logs-level"
            />

            <Chips
              current={component}
              label={logStrings.component}
              onSelect={next => setComponent(next)}
              options={[
                { label: logStrings.componentAll, value: null },
                ...LOG_COMPONENTS.map(name => ({ label: name, value: name }))
              ]}
              testID="logs-component"
            />

            <TextField
              autoCapitalize="none"
              autoCorrect={false}
              label={logStrings.search}
              onChangeText={setSearch}
              placeholder={logStrings.searchPlaceholder}
              testID="logs-search"
              value={search}
            />

            <InsetGroup
              footer={
                <Text color="textMuted" variant="meta">
                  {logStrings.tailHint}
                </Text>
              }
            >
              <InsetRow>
                <View style={{ flexDirection: 'row', gap: theme.space.md }}>
                  <Button
                    onPress={() => setFollowing(current => !current)}
                    testID="logs-follow"
                    title={following ? logStrings.tailOn : logStrings.tailOff}
                    variant={following ? 'primary' : 'secondary'}
                  />
                  <Button
                    onPress={() => {
                      if (copyToClipboard(body.map(line => line.text).join('\n'))) {
                        setNotice(logStrings.copied)
                      }
                    }}
                    testID="logs-copy"
                    title={logStrings.copy}
                    variant="secondary"
                  />
                </View>
              </InsetRow>
            </InsetGroup>

            {error ? (
              <Text color="dangerText" testID="logs-error">
                {logStrings.failed(error)}
              </Text>
            ) : null}

            {notice ? (
              <Text color="textMuted" testID="logs-notice" variant="meta">
                {notice}
              </Text>
            ) : null}

            {unreadable !== null ? (
              /*
                The route answered and this app could not read it. Named, with
                what came back and the one command that settles it — because the
                alternative is the bug this replaced, where a reply the client
                had discarded was reported as an empty file.
              */
              <InsetGroup
                footer={
                  <Text color="textMuted" variant="meta">
                    {logStrings.unexpectedHint}
                  </Text>
                }
              >
                <InsetRow>
                  <Text color="dangerText" testID="logs-unexpected">
                    {logStrings.unexpected(unreadable)}
                  </Text>
                </InsetRow>
                <InsetRow>
                  <Text testID="logs-unexpected-command" variant="code">
                    {logStrings.unexpectedCommand}
                  </Text>
                </InsetRow>
              </InsetGroup>
            ) : page === null ? (
              <Text color="textMuted">{logStrings.loading}</Text>
            ) : body.length === 0 ? (
              <Text color="textMuted" testID="logs-empty">
                {/*
                  An empty FILE and a filter that matched nothing are different
                  facts, and only one of them means the reader should widen
                  what they asked for.
                */}
                {level || component || search.trim() ? logStrings.noMatches : logStrings.empty}
              </Text>
            ) : (
              <>
                <Text color="textMuted" testID="logs-count" variant="meta">
                  {page.capped ? logStrings.truncated(body.length) : logStrings.lineCount(body.length)}
                </Text>

                {/*
                  A horizontal scroller around the lines, because a log line is
                  as long as it is and wrapping one destroys the column
                  alignment that makes a tail readable.

                  `flexGrow: 0` is not decoration. A horizontal `ScrollView`
                  defaults to `flexGrow: 1`, so inside a scrollable column it
                  balloons to the viewport height instead of hugging its
                  content — the same guard `DiffView` and `OverflowScroll`
                  carry, and this was the one horizontal scroller in the app
                  without it.
                */}
                <ScrollView
                  directionalLockEnabled
                  horizontal
                  nestedScrollEnabled
                  showsHorizontalScrollIndicator
                  style={{ flexGrow: 0 }}
                >
                  <View style={{ gap: 2 }}>
                    {body.map(line => (
                      <Text
                        color={
                          line.level === 'ERROR' || line.level === 'CRITICAL'
                            ? 'dangerText'
                            : line.level === 'WARNING'
                              ? 'warnText'
                              : line.level === 'DEBUG'
                                ? 'textMuted'
                                : 'text'
                        }
                        key={line.key}
                        variant="code"
                      >
                        {line.text}
                      </Text>
                    ))}
                  </View>
                </ScrollView>
              </>
            )}
          </>
        )}
      </ScrollView>
    </Screen>
  )
}

/**
 * One row of single-choice chips.
 *
 * Not `SegmentedRow`: that control divides a fixed width between its options
 * and there are six log files and five levels, which on a phone would be six
 * unreadable slivers. These wrap.
 */
function Chips<T extends string | null>({
  current,
  label,
  onSelect,
  options,
  testID
}: {
  current: T
  label: string
  onSelect: (value: T) => void
  options: { label: string; value: T }[]
  testID: string
}) {
  const theme = useTheme()

  return (
    <View style={{ gap: theme.space.xs }}>
      <Text color="textMuted" variant="meta">
        {label}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.xs }}>
        {options.map(option => {
          const selected = option.value === current

          return (
            <Pressable
              accessibilityLabel={option.label}
              accessibilityRole="button"
              aria-selected={selected}
              key={option.value ?? '__all__'}
              onPress={() => onSelect(option.value)}
              style={{
                backgroundColor: selected ? theme.elevation.e3 : theme.tintSunk,
                borderColor: theme.hairlineSoft,
                borderRadius: theme.radii.inset,
                borderWidth: 1,
                paddingHorizontal: theme.space.md,
                paddingVertical: theme.space.xs
              }}
              testID={`${testID}-${option.value ?? 'all'}`}
            >
              <Text color={selected ? 'text' : 'textMuted'} variant="meta">
                {option.label}
              </Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}
