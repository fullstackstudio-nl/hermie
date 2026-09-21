import SwiftUI
import WidgetKit

/**
 Up to three conversations, medium: the top of the chat list, as a glance.

 Three and not four. The row is 30pt of avatar plus two lines of type, and a fourth row at the
 height systemMedium is drawn at leaves the type below the size the app's own scale bottoms out at
 — which would make the widget the one place in Hermie with type nobody chose.

 Ordered by recency, like the small widget and unlike the sidebar, and `snapshot.ts` explains why:
 the list is an arrangement the owner made and scrolls, a widget is four square centimetres that
 get one glance.

 **Each row is its own link**, so a tap lands on the chat under the finger rather than on whichever
 one the widget decided was first. That is `Link` per row rather than `widgetURL` for the square —
 the opposite choice from the small family, for the opposite reason.
 */
struct HermieBotsEntry: TimelineEntry {
  let date: Date
  let bots: [HermieBot]
}

struct HermieBotsProvider: TimelineProvider {
  /** As many as the family draws. See the note above about why it is three. */
  static let rows = 3

  func placeholder(in context: Context) -> HermieBotsEntry {
    HermieBotsEntry(date: Date(), bots: Array(HermieWidgetStore.load().bots.prefix(Self.rows)))
  }

  func getSnapshot(in context: Context, completion: @escaping (HermieBotsEntry) -> Void) {
    completion(placeholder(in: context))
  }

  /** One entry, never expiring: the app reloads this when it has something new. */
  func getTimeline(in context: Context, completion: @escaping (Timeline<HermieBotsEntry>) -> Void) {
    completion(Timeline(entries: [placeholder(in: context)], policy: .never))
  }
}

struct HermieBotsWidgetView: View {
  @Environment(\.colorScheme) private var colorScheme

  let entry: HermieBotsEntry

  var body: some View {
    let colors = HermieColors(dark: colorScheme == .dark)

    Group {
      if entry.bots.isEmpty {
        HermieEmpty(colors: colors)
      } else {
        VStack(spacing: 10) {
          ForEach(entry.bots) { bot in
            if let url = bot.chatURL {
              Link(destination: url) {
                HermieRow(bot: bot, colors: colors)
              }
            } else {
              HermieRow(bot: bot, colors: colors)
            }
          }

          // Pushes a short list to the top rather than spreading two rows over the
          // whole height, which reads as a layout bug rather than as a short list.
          Spacer(minLength: 0)
        }
      }
    }
    .hermieContainerBackground(colors)
  }
}

struct HermieBotsWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "HermieBotsWidget", provider: HermieBotsProvider()) { entry in
      HermieBotsWidgetView(entry: entry)
    }
    .configurationDisplayName("Chats")
    .description("The three most recent conversations, with what is unread and what needs you.")
    .supportedFamilies([.systemMedium])
  }
}
