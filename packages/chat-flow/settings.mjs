export const CHAT_FLOW_DEFAULTS = Object.freeze({
  compact: true,
  keepTurnOutline: true,
  keepOverviewOpen: true,
  responseBranch: true,
  conversationMove: true,
  btwSubtree: true,
  copySessionMarkdown: true,
  messageEdit: true,
  inlineImages: true,
  goalBar: true,
  stageUpdates: true,
  efficientIO: false,
  pragmaticCoding: false,
  effortSlider: true,
  effortMemory: true,
  codeBlockFold: true,
  railHoverOutline: true,
  inlineStepDiff: true,
  omniViewer: false,
  linkTarget: 'builtin',
  quickContextMenu: false,
  contextLimit: 0,
  chatModeBeta: false,
  homeStudio: false
});

export const CHAT_FLOW_KEYS = Object.freeze(Object.keys(CHAT_FLOW_DEFAULTS));
