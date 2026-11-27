import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { nativeSource } from '../lib/native-host.mjs';
import { DEFAULT_SETTINGS, normalizeSettings } from '../lib/settings.mjs';

const inlineImagesSrc = readFileSync(new URL('../lib/native-inline-images.js', import.meta.url), 'utf8');
const nativeClientSrc = readFileSync(new URL('../lib/native-client.js', import.meta.url), 'utf8');
const nativeBindingsSrc = readFileSync(new URL('../lib/native-bindings.js', import.meta.url), 'utf8');

function createHarness(overrides = {}) {
  const ctx = vm.createContext({
    Buffer,
    btoa: str => Buffer.from(str, 'binary').toString('base64'),
    queueMicrotask,
    document: { querySelector: () => null, querySelectorAll: () => [] },
    I: {
      CascadeConfigSchema: 'CascadeConfig',
      CascadePlannerConfigSchema: 'PlannerConfig',
      PromptSectionCustomizationConfigSchema: 'PromptSectionCustomization',
      PromptSectionSchema: 'PromptSection',
      ContextScopeItemSchema: 'ContextScopeItem',
      DynamicContextScopeItemSchema: 'DynamicContextScopeItem',
      TextOrScopeItemSchema: 'TextOrScopeItem',
      MediaSchema: 'Media'
    },
    tc: (_, value) => structuredClone(value),
    Wb: (_, value) => structuredClone(value),
    HU: meta => meta?.index ?? -1,
    ...overrides
  });
  vm.runInContext(nativeClientSrc, ctx);
  vm.runInContext(inlineImagesSrc, ctx);
  return ctx;
}

test('settings default and normalize inlineImages boolean', () => {
  assert.equal(DEFAULT_SETTINGS.inlineImages, true);
  assert.equal(normalizeSettings({ inlineImages: false }).inlineImages, false);
  assert.equal(normalizeSettings({ inlineImages: 'bad' }).inlineImages, true);
});

test('nativeSource bundles native-inline-images.js', () => {
  const bundled = nativeSource('https://127.0.0.1:41234', []);
  assert.ok(bundled.includes('__agyInlineImages'));
  assert.ok(bundled.includes('__agy_inline_img__'));
});

test('inline image helpers match tagged & positional media, split items cleanly, and preserve non-images', () => {
  const ctx = createHarness();
  const api = ctx.__agyInlineImages;

  assert.equal(api.formatChipLabel(1, 'zh-CN'), '图片 1');
  assert.equal(api.formatChipLabel(2, 'zh-TW'), '圖片 2');
  assert.equal(api.formatChipLabel(3, 'en'), 'Image 3');
  assert.equal(api.formatChipLabel(4, 'ja'), '画像 4');

  assert.equal(api.tagMediaDescription('shot.png', 2), '[Image #2] shot.png');
  assert.equal(api.tagMediaDescription('[Image #1] shot.png', 3), '[Image #3] shot.png');
  assert.equal(api.extractDescriptionNumber('[Image #7] design.png'), 7);
  assert.equal(api.stripImagePrefix('[Image #7] design.png'), 'design.png');

  const img1 = { mimeType: 'image/png', description: '[Image #1] a.png', uri: 'file:///brain/media_1.png' };
  const img3 = { mimeType: 'image/jpeg', description: '[Image #3] c.jpg', uri: 'file:///brain/media_3.jpg' };
  const pdf = { mimeType: 'application/pdf', description: 'spec.pdf', uri: 'file:///brain/spec.pdf' };
  const items = [
    { chunk: { case: 'text', value: '对比 [Image #3] 和 [Image #1] 以及未匹配的 [Image #99]' } },
    { chunk: { case: 'item', value: { scopeItem: { case: 'file', value: { absoluteUri: 'file:///foo.js' } } } } }
  ];

  const matched = api.matchStepImages(items, [img1, pdf, img3]);
  assert.deepEqual(Array.from(matched.orderedGallery, g => g.number), [3, 1]);
  assert.equal(matched.byNumber.get(3).media, img3);
  assert.equal(matched.byNumber.get(1).media, img1);
  assert.equal(matched.matchedMediaSet.has(img1), true);
  assert.equal(matched.matchedMediaSet.has(img3), true);
  assert.equal(matched.matchedMediaSet.has(pdf), false);

  const split = api.splitItemsWithInlineImages(items, matched.byNumber, 'scope-1');
  assert.equal(split.length, 6);
  assert.equal(split[0].chunk.value, '对比 ');
  assert.equal(split[1].chunk.case, 'item');
  assert.equal(split[1].chunk.value.scopeItem.value.providerLabel, api.INLINE_IMG_PROVIDER);
  assert.equal(split[1].chunk.value.scopeItem.value.itemValue, '[Image #3]');
  assert.equal(split[2].chunk.value, ' 和 ');
  assert.equal(split[3].chunk.value.scopeItem.value.itemValue, '[Image #1]');
  assert.equal(split[4].chunk.value, ' 以及未匹配的 [Image #99]');
  assert.equal(split[5].chunk.value.scopeItem.case, 'file');

  // Legacy / untagged fallback pairing in order
  const untaggedA = { mimeType: 'image/png', description: 'first.png' };
  const untaggedB = { mimeType: 'image/png', description: 'second.png' };
  const legacyMatch = api.matchStepImages(
    [{ chunk: { case: 'text', value: '[Image #2] before [Image #5]' } }],
    [untaggedA, untaggedB]
  );
  assert.equal(legacyMatch.byNumber.get(2).media, untaggedA);
  assert.equal(legacyMatch.byNumber.get(5).media, untaggedB);
});

test('Lexical plain-text [Image #N] upgrades cleanly to atomic mention nodes and round-trips numbers', () => {
  const ctx = createHarness();
  const api = ctx.__agyInlineImages;

  const doc = {
    root: {
      type: 'root',
      children: [{
        type: 'paragraph',
        children: [{ type: 'text', text: '[Image #1] 对齐文字 [Image #2] 和 [Image #9]' }]
      }]
    }
  };
  const { changed, doc: upgraded } = api.convertPlainImageRefsInLexicalJson(doc, new Set([1, 2]), 'c1');
  assert.equal(changed, true);
  const children = upgraded.root.children[0].children;
  assert.equal(children[0].type, 'contextScopeItemMention');
  assert.equal(children[0].data.resolving, 'true');
  assert.equal(children[0].data.agyImgNum, '1');
  assert.equal(children[1].text, ' 对齐文字 ');
  assert.equal(children[2].type, 'contextScopeItemMention');
  assert.equal(children[2].data.agyImgNum, '2');
  assert.equal(children[3].text, ' 和 [Image #9]');

  const extracted = api.extractLexicalInlineImageNumbers(upgraded);
  assert.deepEqual(JSON.parse(JSON.stringify(extracted.ordered)), [1, 2]);
});

test('syncOutgoingPayload prunes deleted chips, reorders media to text order, and keeps non-images', () => {
  const ctx = createHarness();
  const api = ctx.__agyInlineImages;

  const img1 = { mimeType: 'image/png', description: 'one.png', payload: { case: 'inlineData', value: new Uint8Array([1, 2]) } };
  const img2 = { mimeType: 'image/png', description: 'two.png', payload: { case: 'inlineData', value: new Uint8Array([3, 4]) } };
  const img3 = { mimeType: 'image/png', description: 'three.png', payload: { case: 'inlineData', value: new Uint8Array([5, 6]) } };
  const pdf = { mimeType: 'application/pdf', description: 'doc.pdf' };
  const pool = new Map([[1, img1], [2, img2], [3, img3]]);

  // User deleted [Image #2] and placed [Image #3] before [Image #1]
  const res = api.syncOutgoingPayload({
    cascadeId: 'c-1',
    items: [{ chunk: { case: 'text', value: '把 [Image #3] 改成 [Image #1] 那样' } }],
    media: [img1, img2, img3, pdf]
  }, pool);

  assert.equal(res.payload.media.length, 3);
  assert.equal(res.payload.media[0].description, '[Image #3] three.png');
  assert.equal(res.payload.media[1].description, '[Image #1] one.png');
  assert.equal(res.payload.media[2], pdf);
  assert.deepEqual(Array.from(res.matchedImages, e => e.number), [3, 1]);

  // If user deletes ALL image chips while pool is active, managed images are pruned and PDF remains
  const allDeleted = api.syncOutgoingPayload({
    cascadeId: 'c-1',
    items: [{ chunk: { case: 'text', value: '只发文档' } }],
    media: [img1, pdf]
  }, pool);
  assert.deepEqual(Array.from(allDeleted.payload.media), [pdf]);
});

test('sendUserCascadeMessage injects invisible model image map covering current + earlier turns and stays silent on text-only turns', async () => {
  let sentPayloads = [];
  const historySteps = [
    {
      metadata: { index: 1 },
      step: {
        case: 'userInput',
        value: {
          items: [{ chunk: { case: 'text', value: '[Image #1] 和 [Image #2]' } }],
          media: [
            { mimeType: 'image/png', description: '[Image #1] before.png', uri: 'file:///brain/.user_uploaded/media_100_aaa.png' },
            { mimeType: 'image/png', description: '[Image #2] ref.png', uri: 'file:///brain/.user_uploaded/media_101_bbb.png' }
          ]
        }
      }
    }
  ];
  const service = {
    forkConversation() {},
    async sendUserCascadeMessage(payload) {
      sentPayloads.push(payload);
      return payload;
    }
  };
  const snap = { conversationId: 'conv-img', trajectorySlice: { stepsInSlice: historySteps } };
  const element = {
    '__reactFiber$fixture': {
      tag: 10,
      type: {},
      memoizedProps: { value: service },
      return: {
        tag: 10,
        type: {},
        memoizedProps: { value: { cascadeContext: { state: { agentStateProvider: { getState: () => snap } } } } },
        return: null
      }
    }
  };

  const ctx = createHarness({
    document: { querySelector: () => element, querySelectorAll: () => [] }
  });
  const adapter = ctx.__agyNativeAdapter;
  adapter.setInlineImages(true);

  // Turn 2 with [Image #3] (reordered / pruned)
  const img3 = { mimeType: 'image/png', description: 'new_ui.png', payload: { case: 'inlineData', value: new Uint8Array([9, 8, 7]) } };
  const imgDeleted = { mimeType: 'image/png', description: '[Image #4] deleted.png' };
  await service.sendUserCascadeMessage({
    cascadeId: 'conv-img',
    items: [{ chunk: { case: 'text', value: '把 [Image #1] 改成 [Image #3] 这样' } }],
    media: [imgDeleted, img3]
  });

  assert.equal(sentPayloads.length, 1);
  const sent = sentPayloads[0];
  assert.equal(sent.media.length, 1);
  assert.equal(sent.media[0].description, '[Image #3] new_ui.png');
  const promptSec = sent.cascadeConfig.plannerConfig.promptSectionCustomizationConfig.appendPromptSections
    .find(p => p.title === 'powertools_inline_images')?.content || '';
  assert.ok(promptSec.includes('Uploaded image 1 = [Image #3] (new_ui.png)'));
  assert.ok(promptSec.includes('[Image #1] = media_100_aaa.png, original: before.png'));
  assert.ok(promptSec.includes('[Image #2] = media_101_bbb.png, original: ref.png'));

  // Turn 3 referencing ONLY earlier [Image #1] with no new uploads still keeps earlier-turn map
  await service.sendUserCascadeMessage({
    cascadeId: 'conv-img',
    items: [{ chunk: { case: 'text', value: '再帮我看一下 [Image #1] 左上角' } }],
    media: []
  });
  const refOnlyPrompt = sentPayloads[1].cascadeConfig.plannerConfig.promptSectionCustomizationConfig.appendPromptSections
    .find(p => p.title === 'powertools_inline_images')?.content || '';
  assert.ok(refOnlyPrompt.includes('[Image #1] = media_100_aaa.png'));
  assert.equal(refOnlyPrompt.includes('Current turn uploaded images'), false);

  // Brand-new text-only conversation without any inline images gets zero prompt overhead
  await service.sendUserCascadeMessage({
    cascadeId: 'conv-plain',
    items: [{ chunk: { case: 'text', value: '你好' } }],
    media: []
  });
  const plainSent = sentPayloads[2];
  const plainPrompt = plainSent.cascadeConfig?.plannerConfig?.promptSectionCustomizationConfig?.appendPromptSections
    ?.find(p => p.title === 'powertools_inline_images');
  assert.equal(plainPrompt, undefined);
});

test('inline image hooks wrap and cleanly restore native globals on dispose', () => {
  const origAed = function AedMock(p) { return { kind: 'Aed', p }; };
  const origExc = function ExcMock(p) { return { kind: 'eXc', p }; };
  const origBxc = function BxcMock(p) { return { kind: 'bXc', p }; };
  const origWwc = function WwcMock(p) { return { kind: 'WWc', p }; };
  const origKL = function KLMock(p) { return { kind: 'KL', p }; };

  const fakeReact = {
    createContext: v => ({ _default: v, Provider: 'Provider' }),
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: 'Fragment'
  };

  const ctx = createHarness({
    React: fakeReact,
    B: fakeReact,
    __agyNativeBindings: {
      names: {
        composerMediaStrip: 'symAed',
        userStep: 'symExc',
        userMediaList: 'symBxc',
        userMessageItems: 'symWwc',
        contextScopePill: 'symKL'
      }
    },
    symAed: origAed,
    symExc: origExc,
    symBxc: origBxc,
    symWwc: origWwc,
    symKL: origKL
  });

  ctx.__agyNativeAdapter.setInlineImages(true);
  assert.notEqual(ctx.symAed, origAed);
  assert.notEqual(ctx.symExc, origExc);
  assert.notEqual(ctx.symBxc, origBxc);
  assert.notEqual(ctx.symWwc, origWwc);
  assert.notEqual(ctx.symKL, origKL);

  // Regular @file mentions pass straight through wrapped KL to originalKL with zero wrapper
  const normalMention = ctx.symKL({ item: { scopeItem: { case: 'file', value: { absoluteUri: 'file:///a.js' } } } });
  assert.equal(normalMention.type, origKL);

  // Inline image mentions route to InlineImageMention
  const imgMention = ctx.symKL({
    item: {
      scopeItem: {
        case: 'dynamicContext',
        value: { providerLabel: ctx.__agyInlineImages.INLINE_IMG_PROVIDER, itemValue: '[Image #1]' }
      }
    }
  });
  assert.notEqual(imgMention.type, origKL);

  // Dispose restores every single native global symbol
  ctx.__agyNativeAdapter.dispose();
  assert.equal(ctx.symAed, origAed);
  assert.equal(ctx.symExc, origExc);
  assert.equal(ctx.symBxc, origBxc);
  assert.equal(ctx.symWwc, origWwc);
  assert.equal(ctx.symKL, origKL);
});

test('inlineEditText preserves [Image #N] from Lexical inline image mention nodes', async () => {
  let sentCall = null;
  const img1 = { mimeType: 'image/png', description: '[Image #1] shot.png' };
  const img2 = { mimeType: 'image/png', description: '[Image #2] removed.png' };
  const ctx = createHarness();
  const api = ctx.__agyInlineImages;
  ctx.__agyNativeAdapter.setInlineImages(true);

  const mentionJson = {
    root: {
      type: 'root',
      children: [{
        type: 'paragraph',
        children: [
          {
            type: 'contextScopeItemMention',
            trigger: '@',
            value: 'contextScopeItemMention',
            data: { data: api.serializeInlineImageScopeItem(1, 'c1'), resolving: 'true', agyImgNum: '1' }
          },
          { type: 'text', text: ' 改一下颜色' }
        ]
      }]
    }
  };
  let curState = { toJSON: () => mentionJson };
  let curMedia = [img1, img2];
  const editor = {
    getEditorState: () => curState,
    setEditorState: s => { curState = s; },
    focus() {}
  };
  const box = {
    lexicalRef: { current: editor },
    getMediaAttachments: () => curMedia,
    setMediaAttachments: m => { curMedia = m; },
    getInputCardElement: () => null
  };
  const service = { async cancelCascadeInvocation() {}, async sendUserCascadeMessage() {} };
  const chatCtx = {
    inputBoxRef: { current: box },
    stepHandler: { async revertToIndex() {} },
    async sendMessage(arg) { sentCall = arg; }
  };
  const element = {
    '__reactFiber$fixture': {
      tag: 5,
      memoizedProps: {
        cascadeId: 'c-edit',
        metadata: { index: 2 },
        step: { items: [{ chunk: { case: 'text', value: 'old' } }], media: [img1, img2] }
      },
      return: {
        tag: 10,
        type: {},
        memoizedProps: { value: chatCtx },
        return: {
          tag: 10,
          type: {},
          memoizedProps: { value: service },
          return: null
        }
      }
    }
  };
  ctx.IJ = (_, json) => ({ toJSON: () => JSON.parse(json) });
  ctx.LN = () => JSON.stringify(mentionJson);
  ctx.document = {
    querySelector: () => element,
    querySelectorAll: () => [],
    createElement: () => {
      const listeners = new Map();
      return {
        dataset: {},
        className: '',
        style: {},
        append() {},
        prepend() {},
        remove() {},
        setAttribute() {},
        removeAttribute() {},
        addEventListener(evt, fn) { listeners.set(evt, fn); },
        trigger(evt, payload) { listeners.get(evt)?.(payload); },
        querySelector: () => null
      };
    }
  };
  element.closest = () => null;
  element.prepend = () => {};
  element.setAttribute = () => {};
  element.removeAttribute = () => {};

  // Mount inline edit & simulate hitting Enter
  const host = await ctx.__agyNativeAdapter.beginEdit(element);
  // Restore our rich mention JSON as the edited state
  curState = { toJSON: () => mentionJson };
  const sendEvent = {
    key: 'Enter',
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    isComposing: false,
    keyCode: 13,
    target: { closest: sel => sel === '[contenteditable="true"]' ? {} : null },
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {}
  };
  // Without inlineHost DOM node (inputBox was null), verify helper directly through beginEdit + editAndResend
  assert.ok(host);
  assert.equal(api.parseMentionNodeInlineNumber(mentionJson.root.children[0].children[0]), 1);
  // Trigger direct editAndResend fallback path too
  ctx.__agyNativeAdapter.cancelEdit({ restoreDraft: false });
  await ctx.__agyNativeAdapter.editAndResend(element, '[Image #1] 改一下颜色');
  assert.equal(sentCall.items[0].chunk.value, '[Image #1] 改一下颜色');
});

test('native-bindings resolves all optional inline-image bindings uniquely', () => {
  const ctx = vm.createContext({
    React: {},
    createFileRoute: () => () => {},
    HC: () => 'defaultOpen: matchTriggerWidth: disableMobileSheet:',
    IC: () => 'startDragTracking: popover-trigger-element asChild:',
    JC: () => 'arrowNavigable: matchTriggerWidth: scrollContainerClassName:',
    KC: () => 'asChild: isMobile: setIsOpen:',
    GC: () => 'tooltipPlace: secondaryAction: main-row-trigger',
    Uy: () => 'paddingClassName: computedAriaLabel: asChild:',
    XP: () => 'onCheckedChange: aria-describedby role:"switch"',
    UP: ({label: a}) => ({ rightElement: a, extraContent: 1, descriptionId: 1 }),
    TP: () => 'agy-card bg-transparent rounded-xl border border-border overflow-hidden divide-y divide-border',
    VP: () => 'headerRight: defaultCollapsed: forceExpanded:',
    dq: ({name: a}) => ({ cls: 'google-symbols', kind: 'Icon', a }),
    k0: ({trigger: a}) => ({ triggerVisible: a, onCollapseComplete: 1, defaultExpanded: 1 }),
    Sy: Object.assign(() => 'tip', { displayName: 'CompactTooltipBaseUi' }),
    kT: () => 'ownsHighlight: onHighlightExit: onSearchQueryChange:',
    lT: () => 'asChild: openOnHover: closeDelay: "data-no-drag"',
    mT: () => 'collisionBoundary: pad: alignOffset: keepMounted:',
    nT: () => 'highlighted: selected: action: description: managedHighlight:',
    HU: () => 'sourceTrajectoryStepInfo?.stepIndex',
    segment: () => 'getStepRendererConfig: hasBeenCollapsed: leadingSteps:',
    menu: function fn(a,{onRenameClick:b}) { return { b, onRestoreClick: 1, onCreateGroup: 1 }; },
    I: { CascadeConfigSchema: {} },
    G: { ContextScopeItemSchema: {}, DynamicContextScopeItemSchema: {}, MediaSchema: {}, TextOrScopeItemSchema: {} },
    tc: x => x,
    Wb: () => '.$typeName= .members oneof Object.create',
    IJ: () => '._dirtyElements ._dirtyLeaves ._parsed=!0 JSON.parse',
    LN: () => 'JSON.stringify version:1 contextScope chunk.case',
    // Our 9 optional inline image symbols:
    Aed: () => 'input-attachment-open input-attachment-remove selectedMedia:',
    eXc: () => 'user-message-media-scroll user-message-bubble user-message-content queuedMessageDecoratorsProps:',
    bXc: () => 'retargetStagedUpload pdfViewer resolveUrl nowrap:',
    WWc: () => 'context-scope-mention data-quotable-inline renderLists:',
    KL: () => 'wrapInline: dynamicContext',
    DJ: () => 'originalFilePath: onMediaError: onPrevious: onNext: avatarSpacer',
    EL: () => 'image/svg+xml blobUrl: retrigger:',
    yK: () => 'CortexStepHandlerProvider',
    Af: () => 'JSON.stringify(wf(a,b,c),null,c?.prettySpaces??0)'
  });
  vm.runInContext('resolve = function(checkpointConfig=void 0){ const x=tc(I.CascadeConfigSchema, checkpointConfig); return { lookupCustomModelInfo: x, customModelInfoOverride: 1 }; };', ctx);
  vm.runInContext(nativeBindingsSrc, ctx);
  const { names, bindings } = ctx.__agyResolveNativeBindings([]);
  assert.equal(names.composerMediaStrip, 'Aed');
  assert.equal(names.userStep, 'eXc');
  assert.equal(names.userMediaList, 'bXc');
  assert.equal(names.userMessageItems, 'WWc');
  assert.equal(names.contextScopePill, 'KL');
  assert.equal(names.mediaLightbox, 'DJ');
  assert.equal(names.readMediaHook, 'EL');
  assert.equal(names.stepHandlerHook, 'yK');
  assert.equal(names.protoToJson, 'Af');
  assert.equal(names.commonSchemas, 'G');
  assert.equal(bindings.commonSchemas, ctx.G);
  assert.equal(bindings.names.mediaLightbox, 'DJ');
});

test('composer bridge never hides images when chip insertion fails, and hides only confirmed chips when Gy/IJ succeeds', () => {
  const effects = [];
  let stateSlots = [];
  let hookIdx = 0;
  let refs = [];
  let refIdx = 0;
  const miniReact = {
    Fragment: Symbol('Fragment'),
    createContext: def => ({ _current: def, Provider: ({ children }) => children }),
    useContext: c => c._current,
    useSyncExternalStore: (_, get) => get(),
    useMemo: fn => fn(),
    useCallback: fn => fn,
    useRef(v) {
      const i = refIdx++;
      if (!(i in refs)) refs[i] = { current: v };
      return refs[i];
    },
    useEffect(fn) { effects.push(fn); },
    useState(init) {
      const i = hookIdx++;
      if (!(i in stateSlots)) stateSlots[i] = typeof init === 'function' ? init() : init;
      return [stateSlots[i], v => { stateSlots[i] = typeof v === 'function' ? v(stateSlots[i]) : v; }];
    },
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } };
    }
  };
  function render(node) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(render);
    if (typeof node.type === 'function') return render(node.type(node.props || {}));
    if (node.type === miniReact.Fragment) return render(node.props?.children);
    return { ...node, props: { ...(node.props || {}), children: render(node.props?.children) } };
  }

  let aedReceived = null;
  const origAed = ({ selectedMedia }) => { aedReceived = selectedMedia; return miniReact.createElement('div', { 'data-testid': 'orig-aed' }); };
  const img = { mimeType: 'image/png', description: 'shot.png' };
  const pdf = { mimeType: 'application/pdf', description: 'doc.pdf' };

  // Case 1: Gy throws and IJ is absent -> chip never confirmed -> image MUST stay visible in native Aed!
  const brokenEditor = {
    getEditorState: () => ({ toJSON: () => ({ root: { children: [{ type: 'paragraph', children: [] }] } }) }),
    registerUpdateListener: () => () => {}
  };
  const ctxFail = createHarness({
    React: miniReact,
    B: miniReact,
    Gy: () => { throw new Error('schema mismatch'); },
    __agyNativeBindings: {
      names: { composerMediaStrip: 'symAed' },
      commonSchemas: { ContextScopeItemSchema: { tag: 'CSI' }, DynamicContextScopeItemSchema: { tag: 'DCSI' }, MediaSchema: { tag: 'M' }, TextOrScopeItemSchema: { tag: 'T' } }
    },
    symAed: origAed
  });
  ctxFail.__agyNativeAdapter.findComposer = () => ({ editor: brokenEditor, box: { getMediaAttachments: () => [img, pdf] } });
  ctxFail.__agyNativeAdapter.setInlineImages(true);
  hookIdx = 0; refIdx = 0; effects.length = 0; aedReceived = null;
  render(miniReact.createElement(ctxFail.symAed, { selectedMedia: [img, pdf], setSelectedMedia: () => {} }));
  while (effects.length) effects.shift()();
  hookIdx = 0; refIdx = 0; aedReceived = null;
  render(miniReact.createElement(ctxFail.symAed, { selectedMedia: [img, pdf], setSelectedMedia: () => {} }));
  assert.deepEqual(Array.from(aedReceived), [img, pdf]);

  // Case 2: commonSchemas (G) + IJ fallback inserts chip -> chip confirmed -> Aed hides img and keeps pdf!
  stateSlots = []; refs = []; effects.length = 0;
  let editorDoc = { root: { children: [{ type: 'paragraph', children: [] }] } };
  const workingEditor = {
    getEditorState: () => ({ toJSON: () => editorDoc }),
    setEditorState: next => { editorDoc = next.toJSON(); },
    registerUpdateListener: () => () => {}
  };
  const ctxOk = createHarness({
    React: miniReact,
    B: miniReact,
    IJ: (_, s) => ({ toJSON: () => JSON.parse(s) }),
    __agyNativeBindings: {
      names: { composerMediaStrip: 'symAed' },
      commonSchemas: { ContextScopeItemSchema: { tag: 'CSI' }, DynamicContextScopeItemSchema: { tag: 'DCSI' }, MediaSchema: { tag: 'M' }, TextOrScopeItemSchema: { tag: 'T' } }
    },
    symAed: origAed
  });
  ctxOk.__agyNativeAdapter.findComposer = () => ({ editor: workingEditor, box: { getMediaAttachments: () => [img, pdf] } });
  ctxOk.__agyNativeAdapter.setInlineImages(true);
  hookIdx = 0; refIdx = 0; effects.length = 0; aedReceived = null;
  render(miniReact.createElement(ctxOk.symAed, { selectedMedia: [img, pdf], setSelectedMedia: () => {} }));
  while (effects.length) effects.shift()();
  hookIdx = 0; refIdx = 0; aedReceived = null;
  render(miniReact.createElement(ctxOk.symAed, { selectedMedia: [img, pdf], setSelectedMedia: () => {} }));
  assert.deepEqual(Array.from(aedReceived), [pdf]);
  assert.deepEqual(Array.from(ctxOk.__agyInlineImages.extractLexicalInlineImageNumbers(editorDoc).ordered), [1]);
});

test('sent message pipeline filters duplicate images, renders inline chips, and opens native lightbox on click with gallery navigation', () => {
  // Minimal synchronous React runtime to exercise hooked eXc / bXc / WWc / KL / DJ end-to-end
  let currentCtx = null;
  let stateSlots = [];
  let hookIdx = 0;
  let rerender = null;
  const miniReact = {
    Fragment: Symbol('Fragment'),
    createContext(def) {
      const ctx = { _current: def };
      ctx.Provider = ({ value, children }) => {
        const prev = ctx._current;
        ctx._current = value;
        const out = renderTree(children);
        ctx._current = prev;
        return out;
      };
      return ctx;
    },
    useContext: ctx => ctx._current,
    useSyncExternalStore: (_, get) => get(),
    useMemo: fn => fn(),
    useCallback: fn => fn,
    useRef: v => ({ current: v }),
    useEffect: () => {},
    useState(init) {
      const idx = hookIdx++;
      if (!(idx in stateSlots)) stateSlots[idx] = typeof init === 'function' ? init() : init;
      return [stateSlots[idx], val => {
        stateSlots[idx] = typeof val === 'function' ? val(stateSlots[idx]) : val;
        rerender?.();
      }];
    },
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } };
    }
  };
  function renderTree(node) {
    if (node == null || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return node;
    if (Array.isArray(node)) return node.map(renderTree);
    if (typeof node.type === 'function') return renderTree(node.type(node.props || {}));
    if (node.type === miniReact.Fragment) return renderTree(node.props?.children);
    return { ...node, props: { ...(node.props || {}), children: renderTree(node.props?.children) } };
  }
  function findNodes(tree, pred, out = []) {
    if (!tree || typeof tree !== 'object') return out;
    if (Array.isArray(tree)) { for (const x of tree) findNodes(x, pred, out); return out; }
    if (pred(tree)) out.push(tree);
    findNodes(tree.props?.children, pred, out);
    return out;
  }

  let bXcReceived = null;
  let lightboxProps = null;
  const origBxc = ({ media }) => { bXcReceived = media; return miniReact.createElement('div', { 'data-testid': 'native-media-list' }); };
  const origKL = ({ item }) => miniReact.createElement('span', { 'data-testid': 'native-kl' }, item?.scopeItem?.case || '');
  const origWwc = ({ items }) => miniReact.createElement('div', { 'data-testid': 'wwc' },
    items.map((it, i) => it.chunk.case === 'item'
      ? miniReact.createElement(ctx.symKL, { key: i, item: it.chunk.value })
      : miniReact.createElement('span', { key: i }, it.chunk.value))
  );
  const origExc = ({ step }) => miniReact.createElement('div', { 'data-testid': 'user-input-step' },
    miniReact.createElement(ctx.symBxc, { media: step.media }),
    miniReact.createElement(ctx.symWwc, { items: step.items })
  );
  const fakeDJ = props => { lightboxProps = props; return miniReact.createElement('div', { 'data-testid': 'native-dj-lightbox' }); };

  const ctx = createHarness({
    React: miniReact,
    B: miniReact,
    __agyNativeBindings: {
      mediaLightbox: fakeDJ,
      stepHandlerHook: () => ({ stepHandler: { resolveArtifactUrl: uri => `https://local/${uri}` } }),
      names: {
        userStep: 'symExc',
        userMediaList: 'symBxc',
        userMessageItems: 'symWwc',
        contextScopePill: 'symKL',
        mediaLightbox: 'symDJ'
      }
    },
    symExc: origExc,
    symBxc: origBxc,
    symWwc: origWwc,
    symKL: origKL,
    symDJ: fakeDJ
  });
  ctx.__agyNativeAdapter.setInlineImages(true);
  ctx.__agyNativeAdapter.setInlineImagesLanguage('zh-CN');

  const img1 = { mimeType: 'image/png', description: '[Image #1] a.png', uri: 'media_1.png' };
  const img2 = { mimeType: 'image/png', description: '[Image #2] b.png', uri: 'media_2.png' };
  const pdf = { mimeType: 'application/pdf', description: 'guide.pdf', uri: 'guide.pdf' };
  const step = {
    items: [{ chunk: { case: 'text', value: '[Image #1] 对比 [Image #2]' } }],
    media: [img1, img2, pdf]
  };

  let tree;
  const runRender = () => {
    hookIdx = 0;
    bXcReceived = null;
    lightboxProps = null;
    tree = renderTree(miniReact.createElement(ctx.symExc, { cascadeId: 'c-ui', step }));
  };
  rerender = runRender;
  runRender();

  // bXc only receives the non-image PDF (duplicate inline images hidden!)
  assert.deepEqual(Array.from(bXcReceived), [pdf]);

  // WWc + KL rendered two inline image chips: 图片 1 and 图片 2
  const chips = findNodes(tree, n => n.props?.['data-testid'] === 'agy-inline-image-chip');
  assert.equal(chips.length, 2);
  assert.equal(chips[0].props['data-agy-image-number'], '1');
  assert.equal(chips[1].props['data-agy-image-number'], '2');
  // Only the left button is swallowed; a right click must reach the document-level image context menu.
  for (const button of [2, 1]) {
    let prevented = false, stopped = false;
    chips[0].props.onMouseDown({ button, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
    assert.deepEqual({ prevented, stopped }, { prevented: false, stopped: false }, `button ${button}`);
  }
  let leftPrevented = false, leftStopped = false;
  chips[0].props.onMouseDown({ button: 0, preventDefault() { leftPrevented = true; }, stopPropagation() { leftStopped = true; } });
  assert.deepEqual({ leftPrevented, leftStopped }, { leftPrevented: true, leftStopped: true });

  // Clicking chip 2 opens native DJ lightbox on Image 2 with prev/next gallery callbacks
  chips[1].props.onClick({ preventDefault() {}, stopPropagation() {} });
  assert.ok(lightboxProps);
  assert.equal(lightboxProps.isOpen, true);
  assert.equal(lightboxProps.media, img2);
  assert.equal(lightboxProps.caption, '图片 2');
  assert.equal(lightboxProps.src, 'https://local/media_2.png');
  assert.equal(typeof lightboxProps.onPrevious, 'function');
  assert.equal(typeof lightboxProps.onNext, 'function');

  // Navigating previous switches to Image 1
  lightboxProps.onPrevious();
  assert.equal(lightboxProps.media, img1);
  assert.equal(lightboxProps.caption, '图片 1');

  // Closing hides lightbox
  lightboxProps.onClose();
  assert.equal(lightboxProps, null);
});

test('multi-image paste on new chat keeps all images and exact current-turn mapping when clearInput + optimistic bubble run before send', () => {
  const effects = [];
  let stateSlots = [];
  let refs = [];
  let hookIdx = 0;
  let refIdx = 0;
  const miniReact = {
    Fragment: Symbol('Fragment'),
    createContext: d => ({ _current: d, Provider: ({ children }) => children }),
    useContext: c => c._current,
    useSyncExternalStore: (_, get) => get(),
    useMemo: fn => fn(),
    useCallback: fn => fn,
    useRef(v) { const i = refIdx++; if (!(i in refs)) refs[i] = { current: v }; return refs[i]; },
    useEffect(fn) { effects.push(fn); },
    useState(init) { const i = hookIdx++; if (!(i in stateSlots)) stateSlots[i] = typeof init === 'function' ? init() : init; return [stateSlots[i], v => { stateSlots[i] = v; }]; },
    createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } })
  };
  function render(n) {
    if (!n || typeof n !== 'object') return n;
    if (Array.isArray(n)) return n.map(render);
    if (typeof n.type === 'function') return render(n.type(n.props || {}));
    return n;
  }

  let editorDoc = { root: { children: [{ type: 'paragraph', children: [] }] } };
  let listenerCount = 0;
  const mediaListeners = new Set();
  const editor = {
    getEditorState: () => ({ toJSON: () => editorDoc }),
    setEditorState: s => { editorDoc = s.toJSON(); },
    registerUpdateListener: () => { listenerCount++; return () => {}; }
  };
  let currentMedia = [];
  const box = {
    getMediaAttachments: () => currentMedia,
    subscribeMediaChange: fn => { mediaListeners.add(fn); return () => mediaListeners.delete(fn); }
  };
  // All 3 pasted screenshots share identical original filename "image.png" but distinct staged .user_uploaded URIs
  const img1 = { mimeType: 'image/png', description: 'image.png', uri: 'file:///brain/.user_uploaded/media_101_aaa.png', payload: { case: 'inlineData', value: new Uint8Array([1]) } };
  const img2 = { mimeType: 'image/png', description: 'image.png', uri: 'file:///brain/.user_uploaded/media_102_bbb.png', payload: { case: 'inlineData', value: new Uint8Array([2]) } };
  const img3 = { mimeType: 'image/png', description: 'image.png', uri: 'file:///brain/.user_uploaded/media_103_ccc.png', payload: { case: 'inlineData', value: new Uint8Array([3]) } };
  let optimisticDomSteps = [];

  const ctx = createHarness({
    React: miniReact,
    B: miniReact,
    IJ: (_, s) => ({ toJSON: () => JSON.parse(s) }),
    __agyNativeBindings: {
      names: { composerMediaStrip: 'symAed' },
      commonSchemas: { ContextScopeItemSchema: {}, DynamicContextScopeItemSchema: {}, MediaSchema: {}, TextOrScopeItemSchema: {} }
    },
    symAed: () => null,
    document: {
      querySelector: () => null,
      querySelectorAll: sel => sel === '[data-testid="user-input-step"]' ? optimisticDomSteps : []
    }
  });
  ctx.__agyNativeAdapter.findComposer = () => ({ editor, box });
  ctx.__agyNativeAdapter.setInlineImages(true);

  const flushAed = list => {
    currentMedia = list;
    hookIdx = 0; refIdx = 0;
    render(miniReact.createElement(ctx.symAed, { selectedMedia: currentMedia, setSelectedMedia: next => { currentMedia = typeof next === 'function' ? next(currentMedia) : next; } }));
    while (effects.length) effects.shift()();
  };

  flushAed([img1]);
  flushAed([img1, img2]);
  flushAed([img1, img2, img3]);

  // Same editor reuses the single composer record instead of leaking duplicate listeners
  assert.equal(listenerCount, 1);

  const items = [{ chunk: { case: 'text', value: '[Image #1] [Image #2] [Image #3] 帮我看一下' } }];
  const outgoingMedia = [img1, img2, img3];

  // Simulate Antigravity eLc: 1) clearInput() empties editor & media, firing subscribeMediaChange
  editorDoc = { root: { children: [{ type: 'paragraph', children: [] }] } };
  currentMedia = [];
  for (const fn of mediaListeners) fn();

  // 2) Optimistic user-input-step mounts with newly generated cascadeId BEFORE wrappedSend runs
  optimisticDomSteps = [{
    querySelector: sel => sel === '[data-testid="pending-bubble-pulse"]' ? {} : null,
    __reactFiber$opt: {
      memoizedProps: { cascadeId: 'new-conv-1', metadata: { index: 0 }, step: { items, media: outgoingMedia } },
      return: null
    }
  }];

  // 3) wrappedSend runs prepareOutgoingPayload
  const out = ctx.__agyInlineImages.prepareOutgoingPayload({
    cascadeId: 'new-conv-1',
    items,
    media: outgoingMedia
  });

  assert.equal(out.payload.media.length, 3);
  assert.deepEqual(Array.from(out.payload.media, m => m.uri), [img1.uri, img2.uri, img3.uri]);
  assert.deepEqual(Array.from(out.payload.media, m => m.description), [
    '[Image #1] image.png',
    '[Image #2] image.png',
    '[Image #3] image.png'
  ]);
  assert.ok(out.promptSection.includes('Uploaded image 1 = [Image #1] (media_101_aaa.png, original: image.png)'));
  assert.ok(out.promptSection.includes('Uploaded image 2 = [Image #2] (media_102_bbb.png, original: image.png)'));
  assert.ok(out.promptSection.includes('Uploaded image 3 = [Image #3] (media_103_ccc.png, original: image.png)'));
  assert.equal(out.promptSection.includes('Earlier turns in this conversation:'), false);
});

test('inserting a chip at the front immediately reorders selectedMedia to dialog order and Undo clears stale deleted uri', async () => {
  const effects = [];
  let stateSlots = [];
  let refs = [];
  let hookIdx = 0;
  let refIdx = 0;
  let lexicalListener = null;
  const miniReact = {
    Fragment: Symbol('Fragment'),
    createContext: d => ({ _current: d, Provider: ({ children }) => children }),
    useContext: c => c._current,
    useSyncExternalStore: (_, get) => get(),
    useMemo: fn => fn(),
    useCallback: fn => fn,
    useRef(v) { const i = refIdx++; if (!(i in refs)) refs[i] = { current: v }; return refs[i]; },
    useEffect(fn) { effects.push(fn); },
    useState(init) { const i = hookIdx++; if (!(i in stateSlots)) stateSlots[i] = typeof init === 'function' ? init() : init; return [stateSlots[i], v => { stateSlots[i] = v; }]; },
    createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } })
  };
  function render(n) {
    if (!n || typeof n !== 'object') return n;
    if (Array.isArray(n)) return n.map(render);
    if (typeof n.type === 'function') return render(n.type(n.props || {}));
    return n;
  }

  let nodesList = [];
  const makeEditorState = () => ({
    toJSON: () => ({ root: { type: 'root', children: [{ type: 'paragraph', children: nodesList.map(n => ({ ...n, data: n.data ? { ...n.data } : undefined })) }] } })
  });
  const nodeWrappers = [];
  const editor = {
    getEditorState: makeEditorState,
    _pendingEditorState: { _nodeMap: new Map() },
    update(fn) {
      editor._pendingEditorState._nodeMap = new Map(nodeWrappers.map((w, i) => [String(i), w]));
      fn();
    },
    registerUpdateListener(fn) { lexicalListener = fn; return () => {}; }
  };

  let insertAtFront = false;
  const GyMock = (_ed, scopeItem) => {
    const dc = scopeItem.scopeItem.value;
    const rawObj = {
      type: 'contextScopeItemMention',
      trigger: '@',
      value: 'contextScopeItemMention',
      data: { data: JSON.stringify({ dynamicContext: dc }) },
      version: 1
    };
    const wrapper = {
      getType: () => 'contextScopeItemMention',
      getData: () => rawObj.data,
      setData: next => { rawObj.data = next; }
    };
    nodeWrappers.push(wrapper);
    if (insertAtFront) nodesList.unshift(rawObj);
    else nodesList.push(rawObj);
  };

  const img1 = { mimeType: 'image/png', description: 'first.png', uri: 'file:///.user_uploaded/m1.png', payload: { case: 'inlineData', value: new Uint8Array([1, 2]) } };
  const img2 = { mimeType: 'image/png', description: 'second.png', uri: 'file:///.user_uploaded/m2.png', payload: { case: 'inlineData', value: new Uint8Array([3, 4]) } };
  let currentMedia = [];
  const box = { getMediaAttachments: () => currentMedia };

  const ctx = createHarness({
    React: miniReact,
    B: miniReact,
    Gy: GyMock,
    __agyNativeBindings: {
      names: { composerMediaStrip: 'symAed' },
      commonSchemas: { ContextScopeItemSchema: {}, DynamicContextScopeItemSchema: {}, MediaSchema: {}, TextOrScopeItemSchema: {} }
    },
    symAed: () => null
  });
  ctx.__agyNativeAdapter.findComposer = () => ({ editor, box });
  ctx.__agyNativeAdapter.setInlineImages(true);

  const flushAed = list => {
    currentMedia = list;
    hookIdx = 0; refIdx = 0;
    render(miniReact.createElement(ctx.symAed, {
      selectedMedia: currentMedia,
      setSelectedMedia: next => { currentMedia = typeof next === 'function' ? next(currentMedia) : next; }
    }));
    while (effects.length) effects.shift()();
  };

  // 1. Paste img1 -> [Image #1]
  flushAed([img1]);
  assert.deepEqual(Array.from(currentMedia, m => m.description), ['first.png']);

  // 2. Move cursor to front and paste img2 -> text is [Image #2] [Image #1], without typing any extra character!
  insertAtFront = true;
  flushAed([img1, img2]);
  // Immediately reordered to [img2, img1] matching dialog order!
  assert.deepEqual(Array.from(currentMedia, m => m.description), ['second.png', 'first.png']);

  // 3. Simulate Backspace deleting [Image #2]
  const removedChip = nodesList.shift();
  await new Promise(r => queueMicrotask(r));
  lexicalListener({ editorState: makeEditorState() });
  assert.deepEqual(Array.from(currentMedia, m => m.description), ['first.png']);

  // 4. Simulate Cmd+Z Undo restoring [Image #2] at the front -> stale deleted uri is cleared so lbc re-uploads!
  await new Promise(r => queueMicrotask(r));
  nodesList.unshift(removedChip);
  lexicalListener({ editorState: makeEditorState() });
  assert.equal(currentMedia.length, 2);
  assert.equal(currentMedia[0].description, 'second.png');
  assert.equal(currentMedia[0].uri, '');
  assert.equal(currentMedia[0].payload.value.length, 2);
  assert.equal(currentMedia[1], img1);
});

test('copying and pasting text + image in composer upgrades plain [Image #N] without triggering PendingMentionGuardPlugin loop', async () => {
  const effects = [];
  let stateSlots = [];
  let refs = [];
  let hookIdx = 0;
  let refIdx = 0;
  const updateListeners = new Set();
  const miniReact = {
    Fragment: Symbol('Fragment'),
    createContext: d => ({ _current: d, Provider: ({ children }) => children }),
    useContext: c => c._current,
    useSyncExternalStore: (_, get) => get(),
    useMemo: fn => fn(),
    useCallback: fn => fn,
    useRef(v) { const i = refIdx++; if (!(i in refs)) refs[i] = { current: v }; return refs[i]; },
    useEffect(fn) { effects.push(fn); },
    useState(init) { const i = hookIdx++; if (!(i in stateSlots)) stateSlots[i] = typeof init === 'function' ? init() : init; return [stateSlots[i], v => { stateSlots[i] = v; }]; },
    createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } })
  };
  function render(n) {
    if (!n || typeof n !== 'object') return n;
    if (Array.isArray(n)) return n.map(render);
    if (typeof n.type === 'function') return render(n.type(n.props || {}));
    return n;
  }

  let docChildren = [];
  let setEditorStateCalls = 0;
  const makeState = () => ({
    _nodeMap: new Map(docChildren.map((n, idx) => [String(idx), {
      getType: () => n.type,
      getData: () => n.data,
      setData: next => { n.data = next; }
    }])),
    toJSON: () => ({ root: { type: 'root', children: [{ type: 'paragraph', children: docChildren.map(n => ({ ...n, data: n.data ? { ...n.data } : undefined })) }] } })
  });
  const notifyLexical = () => {
    const editorState = makeState();
    for (const fn of updateListeners) fn({ editorState });
  };
  const editor = {
    getEditorState: makeState,
    setEditorState(parsed) {
      setEditorStateCalls++;
      if (setEditorStateCalls > 20) throw new Error('Infinite setEditorState loop detected');
      const next = parsed.toJSON();
      docChildren = next.root.children[0].children;
      // Simulate Antigravity's PendingMentionGuardPlugin (NGb): any newly "created" mention node born with resolving==='true' is downgraded to plain text!
      let downgraded = false;
      docChildren = docChildren.map(node => {
        if ((node.type === 'contextScopeItemMention' || node.type === 'beautifulMention') && String(node.data?.resolving ?? '') === 'true') {
          downgraded = true;
          return { type: 'text', text: `[Image #${node.data.agyImgNum || '1'}]`, version: 1 };
        }
        return node;
      });
      notifyLexical();
      if (downgraded) notifyLexical();
    },
    update(fn) {
      editor._pendingEditorState = makeState();
      fn();
      editor._pendingEditorState = null;
      notifyLexical();
    },
    registerUpdateListener(fn) { updateListeners.add(fn); return () => updateListeners.delete(fn); }
  };

  const img1 = { mimeType: 'image/png', description: 'shot.png', uri: 'file:///.user_uploaded/shot.png', payload: { case: 'inlineData', value: new Uint8Array([1, 2, 3]) } };
  let currentMedia = [img1];
  const box = { getMediaAttachments: () => currentMedia };

  const ctx = createHarness({
    React: miniReact,
    B: miniReact,
    IJ: (_, s) => ({ toJSON: () => JSON.parse(s) }),
    __agyNativeBindings: {
      names: { composerMediaStrip: 'symAed' },
      commonSchemas: { ContextScopeItemSchema: {}, DynamicContextScopeItemSchema: {}, MediaSchema: {}, TextOrScopeItemSchema: {} }
    },
    symAed: () => null
  });
  ctx.__agyNativeAdapter.findComposer = () => ({ editor, box });
  ctx.__agyNativeAdapter.setInlineImages(true);

  render(miniReact.createElement(ctx.symAed, {
    selectedMedia: currentMedia,
    setSelectedMedia: next => { currentMedia = typeof next === 'function' ? next(currentMedia) : next; }
  }));
  while (effects.length) effects.shift()();
  await new Promise(r => setTimeout(r, 10));

  // Initial image chip was inserted without triggering PendingMentionGuardPlugin and now carries resolving='true'
  assert.equal(docChildren[0].type, 'contextScopeItemMention');
  assert.equal(docChildren[0].data.resolving, 'true');

  // Simulate user copying "文字 + [图片 1]" and pasting into composer (forcePlainTextPaste inserts plain "[Image #1]")
  const beforeCalls = setEditorStateCalls;
  docChildren.push({ type: 'text', text: ' 复制的文字 [Image #1] 再补充', version: 1 });
  notifyLexical();
  await new Promise(r => setTimeout(r, 20));

  // Upgraded cleanly in 1 setEditorState call with zero loop, and both chips carry resolving='true'!
  assert.equal(setEditorStateCalls - beforeCalls, 1);
  const chipNodes = docChildren.filter(n => n.type === 'contextScopeItemMention');
  assert.equal(chipNodes.length, 2);
  assert.equal(chipNodes[0].data.resolving, 'true');
  assert.equal(chipNodes[1].data.resolving, 'true');
  assert.equal(currentMedia.length, 1);
});
