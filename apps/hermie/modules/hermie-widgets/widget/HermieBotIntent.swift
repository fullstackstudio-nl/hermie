import AppIntents

/**
 Which chat the small widget shows, as the reader picks it in the widget's own configuration.

 The list the picker offers is the snapshot's, which means it is the roster the app last saw — a
 widget cannot ask a gateway anything, and a picker that offered a name the app no longer knows
 would configure a widget that can never fill in. The consequence worth knowing: a bot added to
 the gateway does not appear here until the app has run once since.

 The parameter is OPTIONAL and nil means "the most recent chat", which is the default a fresh
 widget gets. That is a deliberate alternative to `EntityQuery.defaultResult()`: a default
 resolved once at configuration time would pin the widget to whichever chat happened to be on top
 the afternoon it was added, and the thing a reader wants from an unconfigured widget is the chat
 that is live NOW. Picking a chat explicitly pins it; leaving it alone keeps it following.
 */
struct HermieBotEntity: AppEntity {
  let id: String
  let name: String

  static var typeDisplayRepresentation: TypeDisplayRepresentation {
    TypeDisplayRepresentation(name: "Chat")
  }

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(name)")
  }

  static var defaultQuery = HermieBotQuery()
}

struct HermieBotQuery: EntityQuery {
  /**
   Resolve the ids a configured widget stored.

   A widget configured for a bot that has since left the roster resolves to nothing, and the
   provider then falls back to the most recent — which is a better answer than an empty square,
   and honest, because the chat it named genuinely is not there any more.
   */
  func entities(for identifiers: [String]) async throws -> [HermieBotEntity] {
    let bots = HermieWidgetStore.load().bots

    return identifiers.compactMap { identifier in
      bots.first { $0.name == identifier }.map { HermieBotEntity(id: $0.name, name: $0.displayName) }
    }
  }

  /** The picker's list, in the snapshot's order: most recently active first. */
  func suggestedEntities() async throws -> [HermieBotEntity] {
    HermieWidgetStore.load().bots.map { HermieBotEntity(id: $0.name, name: $0.displayName) }
  }
}

struct HermieSelectBotIntent: WidgetConfigurationIntent {
  static var title: LocalizedStringResource = "Chat"
  static var description = IntentDescription("Which conversation this widget shows.")

  @Parameter(title: "Chat")
  var bot: HermieBotEntity?
}
