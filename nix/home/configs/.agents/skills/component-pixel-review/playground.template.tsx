/*
 * Component pixel-review playground. Mount it in place of the app's root screen
 * (e.g. `return <Playground />` in app-container.tsx), capture, then delete it.
 *
 * - `Variants` maps a column key to a component: `asis` is the component as
 *   shipped (a copy taken from `git show <base>:<path>`), `tobe` is the edited
 *   one. Both render the same case props, so the two rows differ only in code.
 * - Every case row is CONTAINER_HEIGHT dp tall with a 1px red guide across its
 *   vertical centre. `measure-rows.py` finds the guides, so the rows need no
 *   other marker.
 * - `onLayout` prints `ROW <label> <theme> y=<dp>` -- the readiness condition
 *   the capture loop greps for, and the proof the tree finished laying out.
 * - THEME flips between captures; edit the constant and Fast Refresh re-renders.
 */
import type { ComponentType, ReactNode } from 'react'
import { ScrollView, View } from 'react-native'

// Swap these three for the app's own UI kit and theme provider.
import { Text, useThemeContext } from '<your-ui-kit>'

import ForcedThemeProvider from '<your-forced-theme-provider>'

export const THEME: 'dark' | 'light' = 'dark'

const CONTAINER_HEIGHT = 36

// Derive the case list from the component's own gates (every branch of every
// `condition && <...>` in its JSX), so each row is a state the product can show.
export const CASES: { id: string; props: Record<string, unknown> }[] = [
  // { id: 'A short label', props: { ... } },
]

const Variants: Record<'asis' | 'tobe', ComponentType<any>> = {
  asis: () => null, // NewMessagesBubbleAsIs
  tobe: () => null, // NewMessagesBubble
}

const Guide = () => (
  <View
    pointerEvents="none"
    style={{ position: 'absolute', left: 0, right: 0, top: CONTAINER_HEIGHT / 2 - 0.5, height: 1, backgroundColor: 'red' }}
  />
)

const Row = ({ label, children }: { label: string; children: ReactNode }) => {
  const { theme: { themedColor } } = useThemeContext()
  return (
    <View onLayout={(e) => console.log(`ROW ${label} ${THEME} y=${e.nativeEvent.layout.y}`)}>
      <Text style={{ fontSize: 10, color: themedColor.foreground1, marginHorizontal: 16 }}>{label}</Text>
      <View style={{ height: CONTAINER_HEIGHT }}>
        {children}
        <Guide />
      </View>
    </View>
  )
}

const Sheet = () => {
  const { theme: { themedColor } } = useThemeContext()
  return (
    <View style={{ backgroundColor: themedColor.background1, paddingVertical: 8 }}>
      {CASES.map(({ id, props }) =>
        (Object.keys(Variants) as (keyof typeof Variants)[]).map((variant) => {
          const Component = Variants[variant]
          return (
            <Row key={`${id}-${variant}`} label={`${id} | ${variant}`}>
              <Component {...props} />
            </Row>
          )
        }),
      )}
    </View>
  )
}

const Playground = () => (
  <ScrollView contentContainerStyle={{ paddingTop: 40, minHeight: 2000 }}>
    <ForcedThemeProvider forcedColorScheme={THEME}>
      <Sheet />
    </ForcedThemeProvider>
  </ScrollView>
)

export default Playground
