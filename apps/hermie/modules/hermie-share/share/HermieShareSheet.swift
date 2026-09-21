import SwiftUI

/**
 The sheet somebody sees inside another application's share menu.

 It is small on purpose. A share extension is a modal interruption of whatever
 the person was actually doing, it has a few seconds of attention and a strict
 memory budget, and everything it can offer has to be decided from one JSON file
 — so this is a list, a note field and a button, and nothing that needs a round
 trip to exist.

 ## What it is NOT allowed to do

 Send. There is no gateway here and there cannot be: the socket, the
 credentials and the session live in the app. "Send" writes the entry and asks
 the system to open the app; the app is what talks to a gateway. That split is
 the whole architecture of this feature and it is why the outbox is a durable
 directory rather than a handoff.

 ## The list is the roster the app last saw

 Most recently active first, which is the order the snapshot is already in —
 see `HermieShareRoster`. A share sheet is a glance, and the chat somebody is
 sharing INTO is very often the one they were just in.
 */
struct HermieShareSheet: View {
  let bots: [HermieShareBot]
  /** What was shared, in words, for the line under the title. */
  let summary: String
  /** Whether the attachments have finished loading; "Send" waits for them. */
  let loading: Bool
  let onSend: (_ bot: HermieShareBot, _ note: String) -> Void
  let onCancel: () -> Void

  @State private var note = ""
  @State private var selected: String?

  var body: some View {
    NavigationView {
      Group {
        if bots.isEmpty {
          empty
        } else {
          list
        }
      }
      .navigationTitle("Send to Hermie")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel", action: onCancel)
        }

        ToolbarItem(placement: .confirmationAction) {
          Button("Send") {
            if let bot = bots.first(where: { $0.name == selected }) {
              onSend(bot, note)
            }
          }
          // Both conditions, and the second is the one that is easy to forget:
          // a share of four photographs is still copying bytes for a moment
          // after the sheet appears, and an entry written before the loads
          // finish is an entry with fewer files than the person selected.
          .disabled(selected == nil || loading)
        }
      }
    }
  }

  private var empty: some View {
    VStack(spacing: 12) {
      Text("No chats yet")
        .font(.headline)
      // The actionable half. The commonest cause by far is the first one, and
      // it is not an error — it is an app that has not been opened since the
      // extension was installed.
      Text("Open Hermie once so it can tell this sheet which bots your gateway has.")
        .font(.footnote)
        .foregroundColor(.secondary)
        .multilineTextAlignment(.center)
    }
    .padding()
  }

  private var list: some View {
    List {
      Section {
        ForEach(bots) { bot in
          Button {
            selected = bot.name
          } label: {
            HStack(spacing: 12) {
              HermieShareAvatar(bot: bot)

              Text(bot.displayName)
                .foregroundColor(.primary)
                .lineLimit(1)

              Spacer()

              if selected == bot.name {
                Image(systemName: "checkmark")
                  .foregroundColor(.accentColor)
              }
            }
          }
        }
      } header: {
        Text(summary)
      }

      Section {
        // `axis:` would be the better field and it is iOS 16. The extension
        // builds against the app's own floor, so this is the two-line version
        // that works everywhere the app installs.
        TextField("Add a note (optional)", text: $note)
      }
    }
    .listStyle(.insetGrouped)
  }
}

/**
 The circle beside a name: the bot's own picture, or its initial on the colour
 the app chose.

 The colour is NOT decided here. It arrives as hex in the snapshot, from the
 app's accent table, for the reason `snapshot.ts` gives at length — a second
 palette in a second language is a palette that drifts. White on it is measured
 at AA by `npm run contrast:check` on the app side, which is the only place
 anything can be measured.
 */
private struct HermieShareAvatar: View {
  let bot: HermieShareBot

  var body: some View {
    if let image = HermieShareRoster.avatar(at: bot.avatarPath) {
      Image(uiImage: image)
        .resizable()
        .aspectRatio(contentMode: .fill)
        .frame(width: 32, height: 32)
        .clipShape(Circle())
    } else {
      ZStack {
        Circle()
          .fill(Color(UIColor(hermieHex: bot.colour)))
        Text(bot.initials)
          .font(.system(size: 14, weight: .semibold))
          .foregroundColor(.white)
      }
      .frame(width: 32, height: 32)
    }
  }
}
