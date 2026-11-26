(() => {
  const INLINE_IMG_PROVIDER = '__agy_inline_img__';
  const IMAGE_REF_GLOBAL_RE = /\[Image #(\d+)\]/g;
  const IMAGE_REF_SINGLE_RE = /\[Image #(\d+)\]/;
  const IMAGE_DESC_PREFIX_RE = /^\s*\[Image #(\d+)\]\s*/;

  const getReact = () => (typeof B !== 'undefined' && B) || globalThis.React || null;
  const getBindings = () => globalThis.__agyNativeBindings || {};
  const getHookNames = () => getBindings().names || {};
  const getSchemaBag = () => getBindings().commonSchemas || ((typeof I !== 'undefined' && I?.ContextScopeItemSchema) ? I : getBindings().I || null);
  const getWb = () => (typeof Wb === 'function' ? Wb : getBindings().Wb);
  const getIJ = () => (typeof IJ === 'function' ? IJ : getBindings().IJ);
  const getGy = () => (typeof Gy === 'function' ? Gy : getBindings().Gy);
  const getHU = () => (typeof HU === 'function' ? HU : getBindings().HU);
  const getAdapter = () => globalThis.__agyNativeAdapter || null;

  let enabled = false;
  let language = 'zh-CN';
  let disposed = false;
  let revision = 0;
  const listeners = new Set();
  const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
  const getSnapshot = () => revision;
  const emit = () => {
    revision++;
    for (const fn of listeners) { try { fn(); } catch {} }
  };

  // --- Pure helpers (exposed on __agyInlineImages for direct unit tests) ---

  function isImageMedia(media) {
    if (!media || typeof media !== 'object') return false;
    return String(media.mimeType || '').toLowerCase().startsWith('image/');
  }

  function extractDescriptionNumber(desc) {
    const m = String(desc || '').match(IMAGE_DESC_PREFIX_RE);
    if (!m) return null;
    const n = Number.parseInt(m[1], 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  function stripImagePrefix(desc) {
    return String(desc || '').replace(IMAGE_DESC_PREFIX_RE, '').trim();
  }

  function tagMediaDescription(desc, number) {
    const clean = stripImagePrefix(desc);
    return clean ? `[Image #${number}] ${clean}` : `[Image #${number}]`;
  }

  function cloneMediaWithDescription(media, description) {
    if (!media || typeof media !== 'object') return media;
    if (media.description === description) return media;
    const schemas = getSchemaBag();
    const wb = getWb();
    if (schemas?.MediaSchema && typeof wb === 'function') {
      try { return wb(schemas.MediaSchema, { ...media, description }); } catch {}
    }
    return { ...media, description };
  }

  function formatChipLabel(number, lang = language) {
    if (lang === 'zh-TW' || lang === 'yue') return `圖片 ${number}`;
    if (lang === 'en') return `Image ${number}`;
    if (lang === 'ja') return `画像 ${number}`;
    return `图片 ${number}`;
  }

  function parseInlineImageNumberFromScope(scopeItem) {
    const dc = scopeItem?.case === 'dynamicContext' ? scopeItem.value : null;
    if (!dc || dc.providerLabel !== INLINE_IMG_PROVIDER) return null;
    const m = String(dc.itemValue || dc.itemLabel || '').match(IMAGE_REF_SINGLE_RE);
    if (!m) return null;
    const n = Number.parseInt(m[1], 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  function extractTextImageRefs(items) {
    const all = [];
    const ordered = [];
    const seen = new Set();
    if (!Array.isArray(items)) return { ordered, all };
    const push = num => {
      if (!Number.isInteger(num) || num <= 0) return;
      all.push(num);
      if (!seen.has(num)) { seen.add(num); ordered.push(num); }
    };
    for (const item of items) {
      const chunk = item?.chunk;
      if (!chunk) continue;
      if (chunk.case === 'text' && typeof chunk.value === 'string') {
        IMAGE_REF_GLOBAL_RE.lastIndex = 0;
        let match;
        while ((match = IMAGE_REF_GLOBAL_RE.exec(chunk.value)) !== null) {
          push(Number.parseInt(match[1], 10));
        }
      } else if (chunk.case === 'item') {
        const num = parseInlineImageNumberFromScope(chunk.value?.scopeItem);
        if (num) push(num);
      }
    }
    return { ordered, all };
  }

  function matchStepImages(items, media) {
    const byNumber = new Map();
    const matchedMediaSet = new Set();
    const orderedGallery = [];
    const mediaList = Array.isArray(media) ? media : [];
    const images = mediaList.filter(isImageMedia);
    if (!images.length) return { byNumber, matchedMediaSet, orderedGallery };
    const refs = extractTextImageRefs(items);
    if (!refs.ordered.length) return { byNumber, matchedMediaSet, orderedGallery };

    const refSet = new Set(refs.ordered);
    const usedImages = new Set();

    // Pass 1: exact match via [Image #N] prefix in media.description
    for (const img of images) {
      const descNum = extractDescriptionNumber(img.description);
      if (descNum && refSet.has(descNum) && !byNumber.has(descNum)) {
        byNumber.set(descNum, { number: descNum, media: img });
        usedImages.add(img);
        matchedMediaSet.add(img);
      }
    }

    // Pass 2: pair remaining referenced numbers with remaining image attachments in order
    const remainingImages = images.filter(img => !usedImages.has(img));
    let remIdx = 0;
    for (const num of refs.ordered) {
      if (byNumber.has(num)) continue;
      if (remIdx >= remainingImages.length) break;
      const img = remainingImages[remIdx++];
      byNumber.set(num, { number: num, media: img });
      usedImages.add(img);
      matchedMediaSet.add(img);
    }

    for (const num of refs.ordered) {
      const entry = byNumber.get(num);
      if (entry) orderedGallery.push(entry);
    }
    return { byNumber, matchedMediaSet, orderedGallery };
  }

  function buildInlineImageScopeItem(number, scopeTag = '') {
    const ref = `[Image #${number}]`;
    const schemas = getSchemaBag();
    const wb = getWb();
    const dcPayload = {
      providerLabel: INLINE_IMG_PROVIDER,
      itemValue: ref,
      itemLabel: ref,
      uri: '',
      description: String(scopeTag || '')
    };
    const dc = schemas?.DynamicContextScopeItemSchema && typeof wb === 'function'
      ? wb(schemas.DynamicContextScopeItemSchema, dcPayload)
      : dcPayload;
    return schemas?.ContextScopeItemSchema && typeof wb === 'function'
      ? wb(schemas.ContextScopeItemSchema, { scopeItem: { case: 'dynamicContext', value: dc } })
      : { scopeItem: { case: 'dynamicContext', value: dc } };
  }

  function serializeInlineImageScopeItem(number, scopeTag = '') {
    const ref = `[Image #${number}]`;
    const protoToJson = getBindings().protoToJson;
    const schemas = getSchemaBag();
    if (typeof protoToJson === 'function' && schemas?.ContextScopeItemSchema) {
      try {
        return protoToJson(schemas.ContextScopeItemSchema, buildInlineImageScopeItem(number, scopeTag));
      } catch {}
    }
    return JSON.stringify({
      dynamicContext: {
        providerLabel: INLINE_IMG_PROVIDER,
        itemValue: ref,
        itemLabel: ref,
        uri: '',
        description: String(scopeTag || '')
      }
    });
  }

  function makeTextChunk(value) {
    const schemas = getSchemaBag();
    const wb = getWb();
    return schemas?.TextOrScopeItemSchema && typeof wb === 'function'
      ? wb(schemas.TextOrScopeItemSchema, { chunk: { case: 'text', value } })
      : { chunk: { case: 'text', value } };
  }

  function makeScopeItemChunk(scopeItem) {
    const schemas = getSchemaBag();
    const wb = getWb();
    return schemas?.TextOrScopeItemSchema && typeof wb === 'function'
      ? wb(schemas.TextOrScopeItemSchema, { chunk: { case: 'item', value: scopeItem } })
      : { chunk: { case: 'item', value: scopeItem } };
  }

  function splitItemsWithInlineImages(items, byNumber, scopeTag = '') {
    if (!Array.isArray(items) || !byNumber || !byNumber.size) return items;
    let changed = false;
    const out = [];
    for (const item of items) {
      const chunk = item?.chunk;
      if (chunk?.case !== 'text' || typeof chunk.value !== 'string' || !chunk.value.includes('[Image #')) {
        out.push(item);
        continue;
      }
      const text = chunk.value;
      IMAGE_REF_GLOBAL_RE.lastIndex = 0;
      let lastIdx = 0;
      let match;
      let itemChanged = false;
      const pieces = [];
      while ((match = IMAGE_REF_GLOBAL_RE.exec(text)) !== null) {
        const num = Number.parseInt(match[1], 10);
        if (!byNumber.has(num)) continue;
        itemChanged = true;
        if (match.index > lastIdx) pieces.push(makeTextChunk(text.slice(lastIdx, match.index)));
        pieces.push(makeScopeItemChunk(buildInlineImageScopeItem(num, scopeTag)));
        lastIdx = match.index + match[0].length;
      }
      if (!itemChanged) {
        out.push(item);
      } else {
        changed = true;
        if (lastIdx < text.length) pieces.push(makeTextChunk(text.slice(lastIdx)));
        out.push(...pieces);
      }
    }
    return changed ? out : items;
  }

  function parseMentionNodeInlineNumber(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.type !== 'contextScopeItemMention' && node.type !== 'beautifulMention') return null;
    const data = node.data;
    if (!data || typeof data !== 'object') return null;
    if (data.agyImgNum) {
      const direct = Number.parseInt(String(data.agyImgNum), 10);
      if (Number.isInteger(direct) && direct > 0) return direct;
    }
    const raw = typeof data.data === 'string' ? data.data : '';
    if (!raw || !raw.includes(INLINE_IMG_PROVIDER)) return null;
    try {
      const parsed = JSON.parse(raw);
      const dc = parsed?.dynamicContext || parsed?.scopeItem?.value;
      if (dc?.providerLabel !== INLINE_IMG_PROVIDER) return null;
      const m = String(dc.itemValue || dc.itemLabel || '').match(IMAGE_REF_SINGLE_RE);
      if (m) {
        const n = Number.parseInt(m[1], 10);
        if (Number.isInteger(n) && n > 0) return n;
      }
    } catch {
      const m = raw.match(IMAGE_REF_SINGLE_RE);
      if (m) {
        const n = Number.parseInt(m[1], 10);
        if (Number.isInteger(n) && n > 0) return n;
      }
    }
    return null;
  }

  function extractLexicalInlineImageNumbers(editorStateJson) {
    const ordered = [];
    const all = [];
    const seen = new Set();
    const walk = node => {
      if (!node || typeof node !== 'object') return;
      const num = parseMentionNodeInlineNumber(node);
      if (num) {
        all.push(num);
        if (!seen.has(num)) { seen.add(num); ordered.push(num); }
        return;
      }
      if (Array.isArray(node.children)) {
        for (const child of node.children) walk(child);
      }
    };
    walk(editorStateJson?.root || editorStateJson);
    return { ordered, all };
  }

  function extractLexicalPlainImageRefs(editorStateJson) {
    const ordered = [];
    const seen = new Set();
    const walk = node => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'text' && typeof node.text === 'string' && node.text.includes('[Image #')) {
        IMAGE_REF_GLOBAL_RE.lastIndex = 0;
        let match;
        while ((match = IMAGE_REF_GLOBAL_RE.exec(node.text)) !== null) {
          const n = Number.parseInt(match[1], 10);
          if (Number.isInteger(n) && n > 0 && !seen.has(n)) {
            seen.add(n);
            ordered.push(n);
          }
        }
      }
      if (Array.isArray(node.children)) {
        for (const child of node.children) walk(child);
      }
    };
    walk(editorStateJson?.root || editorStateJson);
    return ordered;
  }

  function convertPlainImageRefsInLexicalJson(doc, availableNumbers, scopeTag = '', serialize = serializeInlineImageScopeItem) {
    if (!doc || typeof doc !== 'object' || !availableNumbers || !availableNumbers.size) {
      return { changed: false, doc };
    }
    let changed = false;
    const transformChildren = children => {
      if (!Array.isArray(children)) return children;
      const out = [];
      for (const child of children) {
        if (child?.type === 'text' && typeof child.text === 'string' && child.text.includes('[Image #')) {
          const text = child.text;
          IMAGE_REF_GLOBAL_RE.lastIndex = 0;
          let lastIdx = 0;
          let match;
          let localChanged = false;
          while ((match = IMAGE_REF_GLOBAL_RE.exec(text)) !== null) {
            const num = Number.parseInt(match[1], 10);
            if (!availableNumbers.has(num)) continue;
            localChanged = true;
            if (match.index > lastIdx) {
              out.push({ ...child, text: text.slice(lastIdx, match.index) });
            }
            out.push({
              trigger: '@',
              value: 'contextScopeItemMention',
              data: { data: serialize(num, scopeTag), resolving: 'true', agyImgNum: String(num) },
              type: 'contextScopeItemMention',
              version: 1
            });
            lastIdx = match.index + match[0].length;
          }
          if (!localChanged) {
            out.push(child);
          } else {
            changed = true;
            if (lastIdx < text.length) out.push({ ...child, text: text.slice(lastIdx) });
          }
        } else if (child && typeof child === 'object' && Array.isArray(child.children)) {
          out.push({ ...child, children: transformChildren(child.children) });
        } else {
          out.push(child);
        }
      }
      return out;
    };
    const nextRoot = doc.root ? { ...doc.root, children: transformChildren(doc.root.children) } : doc.root;
    return { changed, doc: changed ? { ...doc, root: nextRoot } : doc };
  }

  function mediaDisplayFilename(media) {
    const uri = String(media?.uri || '').trim();
    if (uri) {
      const cleaned = uri.split(/[?#]/, 1)[0];
      const base = cleaned.split('/').pop();
      if (base) return base;
    }
    return stripImagePrefix(media?.description || '');
  }

  function collectConversationHistoryImages(cascadeId, stepsOverride = null, { excludeMedia = null } = {}) {
    const excludedRefs = new Set(Array.isArray(excludeMedia) ? excludeMedia.filter(Boolean) : []);
    const excludedUris = new Set(
      Array.isArray(excludeMedia)
        ? excludeMedia.map(m => String(m?.uri || '').trim()).filter(Boolean)
        : []
    );
    const stepOverlapsExcluded = stepVal => {
      if (!excludedRefs.size && !excludedUris.size) return false;
      const media = Array.isArray(stepVal?.media) ? stepVal.media : [];
      return media.some(m => m && (excludedRefs.has(m) || (m.uri && excludedUris.has(String(m.uri).trim()))));
    };

    const steps = [];
    if (Array.isArray(stepsOverride)) {
      for (const st of stepsOverride) {
        if (!st) continue;
        const stepVal = st.step?.case === 'userInput' && st.step.value ? st.step.value : (Array.isArray(st.items) || Array.isArray(st.media) ? st : null);
        if (stepVal && !stepOverlapsExcluded(stepVal)) steps.push({ step: stepVal, metadata: st.metadata });
      }
    } else {
      const adapter = getAdapter();
      const hu = getHU();
      const seenStepIdx = new Set();
      const pushStep = (stepVal, metadata) => {
        if (!stepVal || stepOverlapsExcluded(stepVal)) return;
        const idx = typeof hu === 'function' && metadata ? hu(metadata) : null;
        if (Number.isInteger(idx) && idx >= 0) {
          if (seenStepIdx.has(idx)) return;
          seenStepIdx.add(idx);
        }
        steps.push({ step: stepVal, metadata, stepIndex: idx });
      };

      // 1. Read from native agentStateProvider trajectory slice if available
      if (adapter && typeof document !== 'undefined') {
        const anchors = [
          document.querySelector('[data-testid="conversation-view"]'),
          document.querySelector('[data-testid="agent-input-box"]'),
          document.querySelector('[data-testid="user-input-step"]')
        ].filter(Boolean);
        for (const el of anchors) {
          const provs = adapter.providers?.(el) || [];
          const snap = provs.find(p => p.value?.cascadeContext)?.value?.cascadeContext?.state?.agentStateProvider?.getState?.();
          if (snap && (!cascadeId || snap.conversationId === cascadeId)) {
            const slice = snap.trajectorySlice?.stepsInSlice;
            if (Array.isArray(slice)) {
              for (const item of slice) {
                if (item?.step?.case === 'userInput' && item.step.value) {
                  pushStep(item.step.value, item.metadata);
                }
              }
            }
            break;
          }
        }
        // 2. Fallback / supplement from mounted user-input-step fibers (skipping optimistic pending bubbles)
        for (const el of document.querySelectorAll('[data-testid="user-input-step"]')) {
          if ((excludedRefs.size || excludedUris.size) && el.querySelector?.('[data-testid="pending-bubble-pulse"]')) continue;
          const msg = adapter.userMessage?.(el);
          if (!msg?.step) continue;
          if (cascadeId && msg.cascadeId && msg.cascadeId !== cascadeId) continue;
          pushStep(msg.step, msg.metadata);
        }
      }
    }

    let maxNumber = 0;
    const historyEntries = [];
    const seenHistoryNumbers = new Set();

    for (const entry of steps) {
      const step = entry.step;
      const refs = extractTextImageRefs(step?.items);
      for (const n of refs.all) if (n > maxNumber) maxNumber = n;
      for (const m of Array.isArray(step?.media) ? step.media : []) {
        const dn = extractDescriptionNumber(m?.description);
        if (dn && dn > maxNumber) maxNumber = dn;
      }
      const matched = matchStepImages(step?.items, step?.media);
      for (const item of matched.orderedGallery) {
        if (seenHistoryNumbers.has(item.number)) continue;
        seenHistoryNumbers.add(item.number);
        const filename = mediaDisplayFilename(item.media);
        const origName = stripImagePrefix(item.media?.description || '');
        historyEntries.push({
          number: item.number,
          filename,
          origName: origName && origName !== filename ? origName : ''
        });
      }
    }
    return { maxNumber, historyEntries };
  }

  function syncOutgoingPayload(payload, poolMap = null, historyNumbers = null) {
    if (!payload || typeof payload !== 'object') return { payload, matchedImages: [] };
    const refs = extractTextImageRefs(payload.items);
    const mediaList = Array.isArray(payload.media) ? payload.media : [];
    const images = mediaList.filter(isImageMedia);
    const nonImages = mediaList.filter(m => !isImageMedia(m));
    const hasPool = Boolean(poolMap && poolMap.size > 0);
    const hasTaggedImages = images.some(img => extractDescriptionNumber(img.description) !== null);

    // Leave payload untouched when there are no inline image references, no managed pool, and no tagged images
    if (!refs.ordered.length && !hasPool && !hasTaggedImages) {
      return { payload, matchedImages: [] };
    }

    // If user deleted every single chip before sending: prune managed/tagged images, keep non-images.
    if (!refs.ordered.length) {
      const poolValues = poolMap ? new Set(poolMap.values()) : new Set();
      const remainingImages = images.filter(img => {
        if (poolValues.has(img)) return false;
        const dn = extractDescriptionNumber(img.description);
        return dn === null;
      });
      if (remainingImages.length === images.length) {
        return { payload, matchedImages: [] };
      }
      return {
        payload: { ...payload, media: [...remainingImages, ...nonImages] },
        matchedImages: []
      };
    }

    const usedImages = new Set();
    const byNum = new Map();

    // Pass 1: exact matches from composer pool or explicit [Image #N] description tags
    for (const num of refs.ordered) {
      let found = null;
      if (poolMap?.has(num)) {
        found = poolMap.get(num);
        const sameInPayload = images.find(img => img === found || extractDescriptionNumber(img.description) === num);
        if (sameInPayload) usedImages.add(sameInPayload);
      }
      if (!found) {
        found = images.find(img => !usedImages.has(img) && extractDescriptionNumber(img.description) === num) || null;
        if (found) usedImages.add(found);
      }
      if (found) byNum.set(num, found);
    }

    // Pass 2: untagged fallback ONLY for non-historical numbers and images without a conflicting [Image #M] tag
    for (const num of refs.ordered) {
      if (byNum.has(num)) continue;
      if (historyNumbers?.has(num)) continue;
      const found = images.find(img => !usedImages.has(img) && extractDescriptionNumber(img.description) === null) || null;
      if (found) {
        usedImages.add(found);
        byNum.set(num, found);
      }
    }

    const matchedImages = [];
    for (const num of refs.ordered) {
      const found = byNum.get(num);
      if (!found) continue;
      const tagged = cloneMediaWithDescription(found, tagMediaDescription(found.description, num));
      matchedImages.push({ number: num, media: tagged });
    }

    if (!matchedImages.length) {
      // Prune explicitly tagged images whose chips were removed (e.g. referencing only an earlier turn's [Image #1])
      if (hasTaggedImages || hasPool) {
        const poolValues = poolMap ? new Set(poolMap.values()) : new Set();
        const remainingImages = images.filter(img => !poolValues.has(img) && extractDescriptionNumber(img.description) === null);
        if (remainingImages.length !== images.length) {
          return { payload: { ...payload, media: [...remainingImages, ...nonImages] }, matchedImages: [] };
        }
      }
      return { payload, matchedImages: [] };
    }

    const nextMedia = [...matchedImages.map(e => e.media), ...nonImages];
    return {
      payload: { ...payload, media: nextMedia },
      matchedImages
    };
  }

  function buildInlineImagePromptSection({ currentImages = [], historyEntries = [] } = {}) {
    const cur = Array.isArray(currentImages) ? currentImages.filter(e => e?.number > 0) : [];
    const curNums = new Set(cur.map(e => e.number));
    const hist = Array.isArray(historyEntries) ? historyEntries.filter(e => e?.number > 0 && !curNums.has(e.number)) : [];
    if (!cur.length && !hist.length) return '';

    const lines = [
      'Inline image references (`[Image #N]`) in user messages map strictly to uploaded images:'
    ];
    if (cur.length) {
      lines.push('Current turn uploaded images (matching attachment and <ADDITIONAL_METADATA> order):');
      cur.forEach((entry, idx) => {
        const filename = mediaDisplayFilename(entry.media);
        const origName = stripImagePrefix(entry.media?.description || entry.origName || '');
        const detail = filename && origName && origName !== filename
          ? `${filename}, original: ${origName}`
          : (filename || origName);
        const suffix = detail ? ` (${detail})` : '';
        lines.push(`- Uploaded image ${idx + 1} = [Image #${entry.number}]${suffix}`);
      });
    }
    if (hist.length) {
      lines.push('Earlier turns in this conversation:');
      for (const entry of hist) {
        const detail = entry.filename
          ? (entry.origName ? `${entry.filename}, original: ${entry.origName}` : entry.filename)
          : (entry.origName || 'uploaded image');
        lines.push(`- [Image #${entry.number}] = ${detail}`);
      }
    }
    lines.push('Always resolve every `[Image #N]` mention in the user request to its exact corresponding image above.');
    return lines.join('\n');
  }

  // --- Base64 thumbnail / full-image URL cache ---

  const thumbUrlCache = new WeakMap();
  const fullUrlCache = new WeakMap();

  function bytesToBase64(bytes) {
    if (!bytes) return '';
    const arr = bytes instanceof Uint8Array
      ? bytes
      : bytes instanceof ArrayBuffer
        ? new Uint8Array(bytes)
        : ArrayBuffer.isView(bytes)
          ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          : null;
    if (!arr || !arr.length) return '';
    let binary = '';
    const chunk = 0x2000;
    for (let i = 0; i < arr.length; i += chunk) {
      binary += String.fromCharCode.apply(null, arr.subarray(i, i + chunk));
    }
    return typeof btoa === 'function' ? btoa(binary) : Buffer.from(arr).toString('base64');
  }

  function mediaThumbSrc(media, resolveUrl) {
    if (!media || typeof media !== 'object') return '';
    if (media.thumbnail?.length) {
      let cached = thumbUrlCache.get(media);
      if (!cached) {
        const b64 = bytesToBase64(media.thumbnail);
        if (b64) {
          cached = `data:image/png;base64,${b64}`;
          thumbUrlCache.set(media, cached);
        }
      }
      if (cached) return cached;
    }
    if (media.payload?.case === 'inlineData' && media.payload.value?.length) {
      let cached = fullUrlCache.get(media);
      if (!cached) {
        const b64 = bytesToBase64(media.payload.value);
        if (b64) {
          cached = `data:${media.mimeType || 'image/png'};base64,${b64}`;
          fullUrlCache.set(media, cached);
        }
      }
      if (cached) return cached;
    }
    if (media.uri && typeof resolveUrl === 'function') {
      try { return resolveUrl(media.uri) || ''; } catch {}
    }
    return '';
  }

  function mediaFullSrc(media, resolveUrl) {
    if (!media || typeof media !== 'object') return '';
    if (media.payload?.case === 'inlineData' && media.payload.value?.length) {
      let cached = fullUrlCache.get(media);
      if (!cached) {
        const b64 = bytesToBase64(media.payload.value);
        if (b64) {
          cached = `data:${media.mimeType || 'image/png'};base64,${b64}`;
          fullUrlCache.set(media, cached);
        }
      }
      if (cached) return cached;
    }
    if (media.uri && typeof resolveUrl === 'function') {
      try {
        const url = resolveUrl(media.uri);
        if (url) return url;
      } catch {}
    }
    return mediaThumbSrc(media, resolveUrl);
  }

  // --- Per-composer pool registry ---

  let composerSeq = 0;
  const composerById = new Map();
  const composerByEditor = new WeakMap();
  const composerByCard = new WeakMap();
  let lastClearedSnapshot = null;

  function getOrCreateComposerRecord({ editor, box, card, cascadeId, setSelectedMedia }) {
    let record = (editor && composerByEditor.get(editor)) || (card && composerByCard.get(card)) || null;
    if (!record) {
      const id = `agy-c-${++composerSeq}`;
      record = {
        id,
        pool: new Map(),
        chipConfirmed: new Set(),
        mediaToNum: new WeakMap(),
        editor: editor || null,
        box: box || null,
        card: card || null,
        cascadeId: cascadeId || '',
        setSelectedMedia: setSelectedMedia || null,
        selfSyncing: false,
        insertingChips: false,
        fallbackNative: false,
        openLightbox: null,
        unsubLexical: null,
        unsubMedia: null
      };
      composerById.set(id, record);
      if (editor) composerByEditor.set(editor, record);
      if (card) composerByCard.set(card, record);
    }
    if (editor && record.editor !== editor) {
      record.unsubLexical?.();
      record.unsubLexical = null;
      record.editor = editor;
      composerByEditor.set(editor, record);
    }
    if (card && record.card !== card) {
      record.card = card;
      composerByCard.set(card, record);
    }
    if (box && record.box !== box) {
      record.unsubMedia?.();
      record.unsubMedia = null;
      record.box = box;
    }
    if (cascadeId !== undefined) record.cascadeId = cascadeId || '';
    if (typeof setSelectedMedia === 'function') record.setSelectedMedia = setSelectedMedia;
    ensureComposerListeners(record);
    return record;
  }

  function findComposerRecordForChip(scopeTag, cascadeId) {
    if (scopeTag && composerById.has(scopeTag)) return composerById.get(scopeTag);
    if (cascadeId) {
      for (const rec of composerById.values()) {
        if (rec.cascadeId === cascadeId && rec.pool.size > 0) return rec;
      }
    }
    for (const rec of composerById.values()) {
      if (rec.pool.size > 0) return rec;
    }
    return null;
  }

  function findComposerPoolForCascade(cascadeId) {
    const merged = new Map();
    for (const rec of composerById.values()) {
      if (!rec.pool.size) continue;
      if (cascadeId && rec.cascadeId && rec.cascadeId !== cascadeId) continue;
      if (!cascadeId && rec.cascadeId) continue;
      for (const [num, media] of rec.pool) {
        if (!merged.has(num) || rec.cascadeId === cascadeId) merged.set(num, media);
      }
    }
    if (merged.size > 0) return merged;
    if (
      lastClearedSnapshot
      && Date.now() - lastClearedSnapshot.at < 15000
      && (!cascadeId || !lastClearedSnapshot.cascadeId || lastClearedSnapshot.cascadeId === cascadeId)
    ) {
      return lastClearedSnapshot.pool;
    }
    return null;
  }

  function clearComposerPool(cascadeId) {
    let cleared = false;
    if (lastClearedSnapshot && (!cascadeId || !lastClearedSnapshot.cascadeId || lastClearedSnapshot.cascadeId === cascadeId)) {
      lastClearedSnapshot = null;
    }
    for (const rec of composerById.values()) {
      if (!cascadeId || !rec.cascadeId || rec.cascadeId === cascadeId) {
        if (rec.pool.size || rec.chipConfirmed.size) {
          rec.pool.clear();
          rec.chipConfirmed.clear();
          rec.mediaToNum = new WeakMap();
          cleared = true;
        }
      }
    }
    if (cleared) emit();
  }

  function hasChipInEditor(editor, number) {
    try {
      const json = editor?.getEditorState?.()?.toJSON?.();
      return extractLexicalInlineImageNumbers(json).ordered.includes(number);
    } catch {
      return false;
    }
  }

  function appendInlineImageChipViaJson(editor, number, scopeTag) {
    const ij = getIJ();
    if (!editor?.getEditorState || !editor?.setEditorState || typeof ij !== 'function') return false;
    try {
      const doc = editor.getEditorState().toJSON();
      if (!doc?.root || !Array.isArray(doc.root.children)) return false;
      const cloned = JSON.parse(JSON.stringify(doc));
      let targetPara = null;
      for (let i = cloned.root.children.length - 1; i >= 0; i--) {
        if (cloned.root.children[i]?.type === 'paragraph' && Array.isArray(cloned.root.children[i].children)) {
          targetPara = cloned.root.children[i];
          break;
        }
      }
      if (!targetPara) {
        targetPara = { children: [], direction: null, format: '', indent: 0, textFormat: 0, textStyle: 'paragraph', type: 'paragraph', version: 1 };
        cloned.root.children.push(targetPara);
      }
      targetPara.children.push(
        {
          trigger: '@',
          value: 'contextScopeItemMention',
          data: { data: serializeInlineImageScopeItem(number, scopeTag), resolving: 'true', agyImgNum: String(number) },
          type: 'contextScopeItemMention',
          version: 1
        },
        { detail: 0, format: 0, mode: 'normal', style: '', text: ' ', type: 'text', version: 1 }
      );
      editor.setEditorState(ij(editor, JSON.stringify(cloned)));
      return hasChipInEditor(editor, number);
    } catch {
      return false;
    }
  }

  function insertInlineImageChip(editor, number, scopeTag) {
    if (!editor) return false;
    const gy = getGy();
    if (typeof gy === 'function') {
      try {
        const scopeItem = buildInlineImageScopeItem(number, scopeTag);
        gy(editor, scopeItem);
        editor.update(() => {
          const map = editor._pendingEditorState?._nodeMap || editor.getEditorState?.()?._nodeMap;
          if (!map) return;
          for (const node of [...map.values()]) {
            if (node?.getType?.() === 'contextScopeItemMention' || node?.getType?.() === 'beautifulMention') {
              const d = node.getData?.();
              if (d && d.resolving !== 'true' && typeof d.data === 'string' && d.data.includes(INLINE_IMG_PROVIDER)) {
                node.setData({ ...d, resolving: 'true', agyImgNum: String(number) });
              }
            }
          }
        }, { discrete: true, tag: 'history-merge' });
        if (hasChipInEditor(editor, number)) return true;
      } catch {}
    }
    return appendInlineImageChipViaJson(editor, number, scopeTag);
  }

  function upgradePlainRefsInEditor(record) {
    const editor = record?.editor;
    const ij = getIJ();
    if (!editor?.getEditorState || !editor?.setEditorState || typeof ij !== 'function' || !record.pool.size) return false;
    try {
      const json = editor.getEditorState().toJSON();
      const { changed, doc } = convertPlainImageRefsInLexicalJson(json, new Set(record.pool.keys()), record.id);
      if (!changed) return false;
      record.insertingChips = true;
      try {
        editor.setEditorState(ij(editor, JSON.stringify(doc)));
      } finally {
        record.insertingChips = false;
      }
      return true;
    } catch {
      return false;
    }
  }

  function cloneMediaClearingStaleUri(media) {
    if (!media || typeof media !== 'object' || !media.uri) return media;
    if (!(media.payload?.case === 'inlineData' && media.payload.value?.length > 0)) return media;
    const schemas = getSchemaBag();
    const wb = getWb();
    if (schemas?.MediaSchema && typeof wb === 'function') {
      try { return wb(schemas.MediaSchema, { ...media, uri: '' }); } catch {}
    }
    return { ...media, uri: '' };
  }

  function syncMediaListWithLexical(record, editorState, fallbackMediaList = null) {
    if (!enabled || disposed || !record || record.insertingChips || record.selfSyncing || !record.chipConfirmed.size) return;
    if (typeof record.setSelectedMedia !== 'function') return;
    let json;
    try { json = editorState?.toJSON?.(); } catch { return; }
    if (!json) return;

    // If user pasted plain "[Image #N]" for an image already in the pool, upgrade it to a chip.
    const plainRefs = extractLexicalPlainImageRefs(json);
    if (plainRefs.some(n => record.pool.has(n))) {
      queueMicrotask(() => {
        if (!disposed && enabled) upgradePlainRefsInEditor(record);
      });
    }

    const present = extractLexicalInlineImageNumbers(json);
    const currentMedia = typeof record.box?.getMediaAttachments === 'function'
      ? (record.box.getMediaAttachments() || [])
      : (Array.isArray(fallbackMediaList) ? fallbackMediaList : []);
    const currentImages = currentMedia.filter(isImageMedia);
    const currentImageSet = new Set(currentImages);
    const nonImages = currentMedia.filter(m => !isImageMedia(m));

    // Only manage images whose inline chip was confirmed inserted; never prune unconfirmed images.
    const unmanagedImages = currentImages.filter(img => {
      const num = record.mediaToNum.get(img) || extractDescriptionNumber(img.description);
      return !(num && record.chipConfirmed.has(num));
    });
    const desiredManaged = present.ordered
      .filter(n => record.chipConfirmed.has(n) && record.pool.has(n))
      .map(n => {
        const pooled = record.pool.get(n);
        if (!currentImageSet.has(pooled)) {
          // Restored via Undo / Cut+Paste after native lbc deleted its staged artifact URI: reset uri so lbc re-uploads.
          const fresh = cloneMediaClearingStaleUri(pooled);
          if (fresh !== pooled) {
            record.pool.set(n, fresh);
            record.mediaToNum.set(fresh, n);
            return fresh;
          }
        }
        return pooled;
      });
    const desiredImages = [...desiredManaged, ...unmanagedImages];

    const same = currentImages.length === desiredImages.length
      && currentImages.every((img, idx) => img === desiredImages[idx]);
    if (same) return;

    record.selfSyncing = true;
    try {
      record.setSelectedMedia([...desiredImages, ...nonImages]);
    } catch {}
    queueMicrotask(() => { record.selfSyncing = false; });
  }

  function ensureComposerListeners(record) {
    if (record.editor && !record.unsubLexical && typeof record.editor.registerUpdateListener === 'function') {
      record.unsubLexical = record.editor.registerUpdateListener(({ editorState }) => {
        syncMediaListWithLexical(record, editorState);
      });
    }
    if (record.box && !record.unsubMedia && typeof record.box.subscribeMediaChange === 'function') {
      record.unsubMedia = record.box.subscribeMediaChange(() => {
        if (record.selfSyncing || !record.pool.size) return;
        const list = record.box.getMediaAttachments?.() || [];
        if (list.length === 0) {
          let chipCount = 0;
          try {
            chipCount = extractLexicalInlineImageNumbers(record.editor?.getEditorState?.()?.toJSON?.()).ordered.length;
          } catch {}
          // External clear (e.g. clearInput() right before send): snapshot briefly so resolveConfig/wrappedSend still find it.
          if (chipCount === 0) {
            lastClearedSnapshot = {
              cascadeId: record.cascadeId || '',
              pool: new Map(record.pool),
              orderedNums: [...record.pool.keys()],
              at: Date.now()
            };
            record.pool.clear();
            record.chipConfirmed.clear();
            record.mediaToNum = new WeakMap();
            emit();
          }
        }
      });
    }
  }

  // --- Shared React UI components ---

  const InlineMsgCtx = (() => {
    const R = getReact();
    return R?.createContext ? R.createContext(null) : null;
  })();

  function FallbackLightbox({ gallery, activeIndex, onChangeIndex, onClose, resolveUrl, lang }) {
    const R = getReact();
    const h = R.createElement;
    const entry = gallery[activeIndex];
    const src = entry ? mediaFullSrc(entry.media, resolveUrl) : '';
    const title = entry ? formatChipLabel(entry.number, lang) : '';
    const cleanName = entry ? stripImagePrefix(entry.media?.description || '') : '';

    R.useEffect(() => {
      if (!entry || typeof document === 'undefined') return undefined;
      const onKey = e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
        else if (e.key === 'ArrowLeft' && gallery.length > 1) {
          e.preventDefault();
          onChangeIndex((activeIndex - 1 + gallery.length) % gallery.length);
        } else if (e.key === 'ArrowRight' && gallery.length > 1) {
          e.preventDefault();
          onChangeIndex((activeIndex + 1) % gallery.length);
        }
      };
      document.addEventListener('keydown', onKey, true);
      return () => document.removeEventListener('keydown', onKey, true);
    }, [entry, activeIndex, gallery.length, onClose, onChangeIndex]);

    if (!entry) return null;
    const overlay = h('div', {
      'data-testid': 'agy-inline-image-lightbox',
      className: 'agy-inline-img-lightbox',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': title,
      onClick: e => { if (e.target === e.currentTarget) onClose(); }
    },
      h('div', { className: 'agy-inline-img-lightbox-inner', onClick: e => e.stopPropagation() },
        h('div', { className: 'agy-inline-img-lightbox-bar' },
          h('span', { className: 'agy-inline-img-lightbox-title' }, cleanName ? `${title} - ${cleanName}` : title),
          h('button', {
            type: 'button',
            className: 'agy-inline-img-lightbox-close',
            'aria-label': 'Close',
            onClick: onClose
          }, '×')
        ),
        src
          ? h('img', { src, alt: title, className: 'agy-inline-img-lightbox-img' })
          : h('div', { className: 'agy-inline-img-lightbox-empty' }, title),
        gallery.length > 1 && h('div', { className: 'agy-inline-img-lightbox-nav' },
          h('button', {
            type: 'button',
            className: 'agy-inline-img-lightbox-btn',
            onClick: () => onChangeIndex((activeIndex - 1 + gallery.length) % gallery.length)
          }, '←'),
          h('span', { className: 'agy-inline-img-lightbox-count' }, `${activeIndex + 1} / ${gallery.length}`),
          h('button', {
            type: 'button',
            className: 'agy-inline-img-lightbox-btn',
            onClick: () => onChangeIndex((activeIndex + 1) % gallery.length)
          }, '→')
        )
      )
    );
    const portal = globalThis.ReactDOM?.createPortal;
    return typeof portal === 'function' && document?.body ? portal(overlay, document.body) : overlay;
  }

  function InlineLightbox({ gallery, activeIndex, onChangeIndex, onClose, resolveUrl, cascadeId, lang }) {
    const R = getReact();
    if (!R || activeIndex < 0 || !Array.isArray(gallery) || activeIndex >= gallery.length) return null;
    const entry = gallery[activeIndex];
    if (!entry?.media) return null;
    const NativeLightbox = getBindings().mediaLightbox;
    const fullSrc = mediaFullSrc(entry.media, resolveUrl);
    const caption = formatChipLabel(entry.number, lang);
    const cleanName = stripImagePrefix(entry.media.description || '');

    if (typeof NativeLightbox === 'function') {
      return R.createElement(NativeLightbox, {
        media: entry.media,
        isOpen: true,
        onClose,
        src: fullSrc || undefined,
        originalFilePath: cleanName || entry.media.uri || caption,
        conversationId: cascadeId || undefined,
        caption,
        itemKey: `agy-img-${entry.number}`,
        onPrevious: gallery.length > 1 ? () => onChangeIndex((activeIndex - 1 + gallery.length) % gallery.length) : undefined,
        onNext: gallery.length > 1 ? () => onChangeIndex((activeIndex + 1) % gallery.length) : undefined
      });
    }
    return R.createElement(FallbackLightbox, { gallery, activeIndex, onChangeIndex, onClose, resolveUrl, lang });
  }

  function InlineImageChip({ number, media, resolveUrl, cascadeId, onOpen, lang }) {
    const R = getReact();
    const h = R.createElement;
    const chipRef = R.useRef(null);
    const [hoverRect, setHoverRect] = R.useState(null);

    const directThumb = mediaThumbSrc(media, resolveUrl);
    const readMediaHook = getBindings().readMediaHook;
    const needReadUri = !directThumb && media?.uri ? media.uri : undefined;
    const readRes = typeof readMediaHook === 'function'
      ? readMediaHook(needReadUri, undefined, media?.mimeType, cascadeId || undefined)
      : null;
    const thumbSrc = directThumb || readRes?.blobUrl || '';
    const previewSrc = mediaFullSrc(media, resolveUrl) || thumbSrc;
    const label = formatChipLabel(number, lang);
    const cleanName = stripImagePrefix(media?.description || '');

    R.useEffect(() => {
      if (!hoverRect || typeof window === 'undefined') return undefined;
      const hide = () => setHoverRect(null);
      window.addEventListener('scroll', hide, true);
      window.addEventListener('blur', hide);
      return () => {
        window.removeEventListener('scroll', hide, true);
        window.removeEventListener('blur', hide);
      };
    }, [hoverRect]);

    const handleEnter = () => {
      if (!previewSrc || !chipRef.current?.getBoundingClientRect) return;
      const rect = chipRef.current.getBoundingClientRect();
      if (rect.width || rect.height) setHoverRect(rect);
    };

    const handleClick = e => {
      e.preventDefault?.();
      e.stopPropagation?.();
      setHoverRect(null);
      onOpen?.(number);
    };

    const handleMouseDown = e => {
      // Right and middle clicks keep their native/context-menu path (image right-click menu, autoscroll).
      if (e.button !== 0) return;
      // Keep editor cursor stable when clicking chip to open lightbox,
      // and prevent parent user-message bubble from starting an edit/expand click.
      e.preventDefault?.();
      e.stopPropagation?.();
    };

    const fallbackIcon = h('svg', {
      viewBox: '0 0 16 16',
      width: 11,
      height: 11,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      className: 'agy-inline-img-fallback-icon',
      'aria-hidden': 'true'
    },
      h('rect', { x: 2, y: 2.5, width: 12, height: 11, rx: 1.8 }),
      h('circle', { cx: 5.5, cy: 6, r: 1.1, fill: 'currentColor', stroke: 'none' }),
      h('path', { d: 'M3.2 11.5l3-3 2.2 2 1.8-1.6 2.6 2.6', strokeLinecap: 'round', strokeLinejoin: 'round' })
    );

    let hoverNode = null;
    if (hoverRect && previewSrc) {
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
      const placeBelow = hoverRect.top < 210;
      const centerX = Math.max(132, Math.min(vw - 132, hoverRect.left + hoverRect.width / 2));
      const style = placeBelow
        ? { left: `${Math.round(centerX)}px`, top: `${Math.round(hoverRect.bottom + 8)}px`, transform: 'translateX(-50%)' }
        : { left: `${Math.round(centerX)}px`, top: `${Math.round(hoverRect.top - 8)}px`, transform: 'translate(-50%, -100%)' };
      const previewEl = h('div', {
        className: 'agy-inline-img-hover',
        'data-testid': 'agy-inline-image-hover',
        style
      },
        h('img', { src: previewSrc, alt: label, className: 'agy-inline-img-hover-img' }),
        h('div', { className: 'agy-inline-img-hover-caption' },
          h('span', { className: 'agy-inline-img-hover-num' }, label),
          cleanName && h('span', { className: 'agy-inline-img-hover-name' }, cleanName)
        )
      );
      const portal = globalThis.ReactDOM?.createPortal;
      hoverNode = typeof portal === 'function' && document?.body ? portal(previewEl, document.body) : previewEl;
    }

    return h(R.Fragment, null,
      h('span', {
        ref: chipRef,
        className: 'agy-inline-img-chip',
        'data-testid': 'agy-inline-image-chip',
        'data-agy-image-number': String(number),
        'data-no-scroll-jump': 'true',
        role: 'button',
        tabIndex: -1,
        'aria-label': cleanName ? `${label} (${cleanName})` : label,
        onMouseEnter: handleEnter,
        onMouseLeave: () => setHoverRect(null),
        onMouseDown: handleMouseDown,
        onClick: handleClick
      },
        h('span', { className: 'agy-inline-img-thumb' },
          thumbSrc
            ? h('img', { src: thumbSrc, alt: '', draggable: false, className: 'agy-inline-img-thumb-img' })
            : fallbackIcon
        ),
        h('span', { className: 'agy-inline-img-label' }, label)
      ),
      hoverNode
    );
  }

  // --- Hooked React boundary components (fixed hook counts for React #311 safety) ---

  function InlineComposerMediaBridge({ props, Original }) {
    const R = getReact();
    const h = R.createElement;
    R.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const anchorRef = R.useRef(null);
    const recordRef = R.useRef(null);
    const [lightboxIdx, setLightboxIdx] = R.useState(-1);

    const selectedMedia = Array.isArray(props?.selectedMedia) ? props.selectedMedia : [];
    const setSelectedMedia = props?.setSelectedMedia;
    const canInline = enabled && !disposed && (typeof getGy() === 'function' || typeof getIJ() === 'function') && !recordRef.current?.fallbackNative;

    const stepHandlerHook = getBindings().stepHandlerHook;
    let stepHandler = null;
    if (typeof stepHandlerHook === 'function') {
      try { stepHandler = stepHandlerHook()?.stepHandler || null; } catch {}
    }
    const resolveUrl = stepHandler?.resolveArtifactUrl;

    R.useEffect(() => {
      if (!enabled || disposed) return;
      const images = selectedMedia.filter(isImageMedia);
      if (!images.length) return;
      const adapter = getAdapter();
      const anchor = anchorRef.current;
      const card = anchor?.closest?.('.surface-composer-card') || null;
      const found = adapter?.findComposer?.(anchor || card) || null;
      const editor = found?.editor || card?.querySelector?.('[contenteditable="true"]')?.__lexicalEditor || null;
      const box = found?.box || null;
      if (!editor) {
        if (recordRef.current && !recordRef.current.fallbackNative) {
          recordRef.current.fallbackNative = true;
          emit();
        }
        return;
      }
      const cascadeId = adapter?.composerCascadeId?.(anchor || card) || '';
      const record = getOrCreateComposerRecord({ editor, box, card, cascadeId, setSelectedMedia });
      record.fallbackNative = false;
      recordRef.current = record;

      let editorJson = null;
      try { editorJson = editor.getEditorState?.()?.toJSON?.(); } catch {}
      const existingChipNums = new Set(extractLexicalInlineImageNumbers(editorJson).ordered);
      const plainRefs = extractLexicalPlainImageRefs(editorJson);
      const historyInfo = collectConversationHistoryImages(cascadeId);
      let maxNum = historyInfo.maxNumber;
      for (const k of record.pool.keys()) if (k > maxNum) maxNum = k;

      const newlyAdded = [];
      const selectedMediaSet = new Set(selectedMedia);

      for (let i = 0; i < selectedMedia.length; i++) {
        const media = selectedMedia[i];
        if (!isImageMedia(media)) continue;
        let num = record.mediaToNum.get(media);
        if (!num) {
          const descNum = extractDescriptionNumber(media.description);
          const pooledForDesc = descNum ? record.pool.get(descNum) : null;
          const canClaimDesc = Boolean(
            descNum && (
              !pooledForDesc
              || pooledForDesc === media
              || (!existingChipNums.has(descNum) && !selectedMediaSet.has(pooledForDesc))
            )
          );
          if (canClaimDesc) {
            num = descNum;
          } else {
            const unmappedPlain = plainRefs.find(n => {
              const cur = record.pool.get(n);
              return !cur || (!existingChipNums.has(n) && !selectedMediaSet.has(cur));
            });
            if (unmappedPlain) {
              num = unmappedPlain;
            } else {
              num = ++maxNum;
            }
          }
          if (num > maxNum) maxNum = num;
          // Preserve the original Media object identity so Antigravity's native WeakMap & setter stay intact.
          record.pool.set(num, media);
          record.mediaToNum.set(media, num);
          newlyAdded.push(num);
        } else if (!record.chipConfirmed.has(num) && existingChipNums.has(num)) {
          record.chipConfirmed.add(num);
        }
      }

      if (newlyAdded.length) {
        record.insertingChips = true;
        try {
          // 1. Upgrade any matching plain-text [Image #N] (from edit/revert/paste) into chips
          upgradePlainRefsInEditor(record);
          let afterJson = null;
          try { afterJson = editor.getEditorState?.()?.toJSON?.(); } catch {}
          const afterChips = new Set(extractLexicalInlineImageNumbers(afterJson).ordered);
          // 2. Insert chips at cursor for any newly added image still not referenced
          for (const num of newlyAdded) {
            if (afterChips.has(num) || existingChipNums.has(num)) {
              record.chipConfirmed.add(num);
            } else if (insertInlineImageChip(editor, num, record.id)) {
              record.chipConfirmed.add(num);
              afterChips.add(num);
            }
          }
        } finally {
          record.insertingChips = false;
        }
        // Immediately align selectedMedia order to dialog chip order without waiting for a subsequent keystroke.
        syncMediaListWithLexical(record, editor.getEditorState?.(), selectedMedia);
        emit();
      }
    }, [enabled, selectedMedia, setSelectedMedia]);

    const composerGallery = R.useMemo(() => {
      const rec = recordRef.current;
      const out = [];
      for (const m of selectedMedia) {
        if (!isImageMedia(m)) continue;
        const num = rec?.mediaToNum.get(m) || extractDescriptionNumber(m.description);
        if (num) out.push({ number: num, media: m });
      }
      return out;
    }, [selectedMedia, revision]);

    R.useEffect(() => {
      const rec = recordRef.current;
      if (!rec) return;
      rec.openLightbox = num => {
        const idx = composerGallery.findIndex(g => g.number === num);
        setLightboxIdx(idx >= 0 ? idx : (composerGallery.length ? 0 : -1));
      };
      return () => {
        if (rec.openLightbox) rec.openLightbox = null;
      };
    }, [composerGallery]);

    if (!canInline) {
      return h(Original, props);
    }

    // Only hide an image from the native top bar once its inline Lexical chip is verified inserted.
    const rec = recordRef.current;
    const filteredMedia = selectedMedia.filter(m => {
      if (!isImageMedia(m)) return true;
      const num = rec?.mediaToNum.get(m);
      return !(num && rec?.chipConfirmed?.has(num));
    });
    const anchorState = filteredMedia.length === 0 ? 'empty' : 'has-other';

    return h(R.Fragment, null,
      h('span', {
        ref: anchorRef,
        'data-agy-inline-media-anchor': anchorState,
        style: { display: 'none' }
      }),
      filteredMedia.length > 0 && h(Original, { ...props, selectedMedia: filteredMedia }),
      lightboxIdx >= 0 && h(InlineLightbox, {
        gallery: composerGallery,
        activeIndex: lightboxIdx,
        onChangeIndex: setLightboxIdx,
        onClose: () => setLightboxIdx(-1),
        resolveUrl,
        cascadeId: recordRef.current?.cascadeId || '',
        lang: language
      })
    );
  }

  function InlineMsgScope({ props, Original }) {
    const R = getReact();
    const h = R.createElement;
    R.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const [lightboxIdx, setLightboxIdx] = R.useState(-1);

    const stepHandlerHook = getBindings().stepHandlerHook;
    let stepHandler = null;
    if (typeof stepHandlerHook === 'function') {
      try { stepHandler = stepHandlerHook()?.stepHandler || null; } catch {}
    }
    const resolveUrl = stepHandler?.resolveArtifactUrl;
    const active = enabled && !disposed;
    const step = props?.step;
    const cascadeId = props?.cascadeId || '';

    const matched = R.useMemo(
      () => active ? matchStepImages(step?.items, step?.media) : { byNumber: new Map(), matchedMediaSet: new Set(), orderedGallery: [] },
      [active, step?.items, step?.media]
    );

    const openLightbox = R.useCallback(num => {
      const idx = matched.orderedGallery.findIndex(g => g.number === num);
      if (idx >= 0) setLightboxIdx(idx);
    }, [matched.orderedGallery]);

    const ctxValue = R.useMemo(() => {
      if (!active || !matched.byNumber.size) return null;
      return {
        cascadeId,
        byNumber: matched.byNumber,
        matchedMediaSet: matched.matchedMediaSet,
        orderedGallery: matched.orderedGallery,
        openLightbox,
        resolveUrl
      };
    }, [active, cascadeId, matched, openLightbox, resolveUrl]);

    if (!InlineMsgCtx) return h(Original, props);
    return h(InlineMsgCtx.Provider, { value: ctxValue },
      h(Original, props),
      active && lightboxIdx >= 0 && h(InlineLightbox, {
        gallery: matched.orderedGallery,
        activeIndex: lightboxIdx,
        onChangeIndex: setLightboxIdx,
        onClose: () => setLightboxIdx(-1),
        resolveUrl,
        cascadeId,
        lang: language
      })
    );
  }

  function InlineMessageMediaFilter({ props, Original }) {
    const R = getReact();
    const h = R.createElement;
    R.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const msgCtx = InlineMsgCtx ? R.useContext(InlineMsgCtx) : null;
    if (!enabled || disposed || !msgCtx?.matchedMediaSet?.size || !Array.isArray(props?.media)) {
      return h(Original, props);
    }
    const remaining = props.media.filter(m => !msgCtx.matchedMediaSet.has(m));
    if (!remaining.length) {
      return h('span', { 'data-agy-inline-media-empty': '', style: { display: 'none' } });
    }
    return h(Original, { ...props, media: remaining });
  }

  function InlineMessageContent({ props, Original }) {
    const R = getReact();
    const h = R.createElement;
    R.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const msgCtx = InlineMsgCtx ? R.useContext(InlineMsgCtx) : null;
    const nextItems = R.useMemo(() => {
      if (!enabled || disposed || !msgCtx?.byNumber?.size) return props?.items;
      return splitItemsWithInlineImages(props?.items, msgCtx.byNumber, '');
    }, [enabled, disposed, msgCtx?.byNumber, props?.items]);
    return h(Original, nextItems === props?.items ? props : { ...props, items: nextItems });
  }

  function InlineImageMention({ props, dc, Original }) {
    const R = getReact();
    const h = R.createElement;
    R.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const msgCtx = InlineMsgCtx ? R.useContext(InlineMsgCtx) : null;
    const num = parseInlineImageNumberFromScope(props?.item?.scopeItem);
    if (!num) return h(Original, props);

    // 1. Inside a sent user message bubble
    if (msgCtx?.byNumber?.has(num)) {
      const entry = msgCtx.byNumber.get(num);
      return h(InlineImageChip, {
        number: num,
        media: entry.media,
        resolveUrl: msgCtx.resolveUrl,
        cascadeId: msgCtx.cascadeId,
        onOpen: msgCtx.openLightbox,
        lang: language
      });
    }

    // 2. Inside a Lexical composer
    const scopeTag = String(dc?.description || '');
    const rec = findComposerRecordForChip(scopeTag, '');
    const media = rec?.pool?.get(num) || null;
    const stepHandlerHook = getBindings().stepHandlerHook;
    let resolveUrl;
    if (typeof stepHandlerHook === 'function') {
      try { resolveUrl = stepHandlerHook()?.stepHandler?.resolveArtifactUrl; } catch {}
    }
    return h(InlineImageChip, {
      number: num,
      media,
      resolveUrl,
      cascadeId: rec?.cascadeId || '',
      onOpen: n => rec?.openLightbox?.(n),
      lang: language
    });
  }

  // --- Global symbol hook installation & restoration ---

  const hooked = new Map();

  function installHook(bindingKey, createWrapper) {
    const symbolName = getHookNames()[bindingKey];
    if (!symbolName || typeof globalThis[symbolName] !== 'function') return false;
    if (hooked.has(bindingKey)) return true;
    const original = globalThis[symbolName];
    const wrapped = createWrapper(original);
    hooked.set(bindingKey, { symbolName, original, wrapped });
    globalThis[symbolName] = wrapped;
    return true;
  }

  function restoreHooks() {
    for (const { symbolName, original, wrapped } of hooked.values()) {
      if (globalThis[symbolName] === wrapped) {
        globalThis[symbolName] = original;
      }
    }
    hooked.clear();
  }

  function ensureHooks() {
    if (!enabled || disposed || !getReact()) return;
    installHook('composerMediaStrip', Original => function AgyComposerMediaStrip(props) {
      return getReact().createElement(InlineComposerMediaBridge, { props, Original });
    });
    installHook('userStep', Original => function AgyUserStep(props) {
      return getReact().createElement(InlineMsgScope, { props, Original });
    });
    installHook('userMediaList', Original => function AgyUserMediaList(props) {
      return getReact().createElement(InlineMessageMediaFilter, { props, Original });
    });
    installHook('userMessageItems', Original => function AgyUserMessageItems(props) {
      return getReact().createElement(InlineMessageContent, { props, Original });
    });
    installHook('contextScopePill', Original => function AgyContextScopePill(props) {
      const dc = props?.item?.scopeItem?.case === 'dynamicContext' ? props.item.scopeItem.value : null;
      if (dc?.providerLabel === INLINE_IMG_PROVIDER) {
        return getReact().createElement(InlineImageMention, { props, dc, Original });
      }
      return getReact().createElement(Original, props);
    });
  }

  // --- Public bridge for native-client.js and native-ui.js ---

  function prepareOutgoingPayload(payload, { stepsOverride = null } = {}) {
    if (!enabled || disposed || !payload || typeof payload !== 'object') {
      return { payload, promptSection: '', matchedImages: [] };
    }
    const cascadeId = payload.cascadeId || '';
    const pool = findComposerPoolForCascade(cascadeId);
    const excludeMedia = [
      ...(Array.isArray(payload.media) ? payload.media : []),
      ...(pool ? [...pool.values()] : [])
    ];
    const { historyEntries } = collectConversationHistoryImages(cascadeId, stepsOverride, { excludeMedia });
    const historyNumbers = new Set(historyEntries.map(e => e.number));
    const { payload: nextPayload, matchedImages } = syncOutgoingPayload(payload, pool, historyNumbers);
    const promptSection = buildInlineImagePromptSection({
      currentImages: matchedImages,
      historyEntries
    });
    return { payload: nextPayload, promptSection, matchedImages };
  }

  function buildPromptSectionForCascade(cascadeId = '', { stepsOverride = null } = {}) {
    if (!enabled || disposed) return '';
    const pool = findComposerPoolForCascade(cascadeId);
    let currentImages = [];
    if (pool && pool.size) {
      // Read live chip order from the active composer's editor if available
      let rec = null;
      for (const r of composerById.values()) {
        if (r.pool.size && (!cascadeId || !r.cascadeId || r.cascadeId === cascadeId)) { rec = r; break; }
      }
      let orderedNums = [...pool.keys()];
      try {
        const parsed = extractLexicalInlineImageNumbers(rec?.editor?.getEditorState?.()?.toJSON?.());
        if (parsed.ordered.length) orderedNums = parsed.ordered;
      } catch {}
      currentImages = orderedNums
        .filter(n => pool.has(n))
        .map(n => ({ number: n, media: pool.get(n) }));
    }
    const excludeMedia = currentImages.map(e => e.media);
    const { historyEntries } = collectConversationHistoryImages(cascadeId, stepsOverride, { excludeMedia });
    return buildInlineImagePromptSection({ currentImages, historyEntries });
  }

  function onMessageSent(cascadeId) {
    clearComposerPool(cascadeId);
  }

  function setEnabled(next) {
    const flag = next === true;
    if (enabled === flag && (!flag || hooked.size > 0)) return;
    enabled = flag;
    if (enabled) ensureHooks();
    emit();
  }

  function setLanguage(lang) {
    const next = String(lang || 'zh-CN');
    if (language === next) return;
    language = next;
    emit();
  }

  function dispose() {
    disposed = true;
    enabled = false;
    lastClearedSnapshot = null;
    restoreHooks();
    for (const rec of composerById.values()) {
      try { rec.unsubLexical?.(); } catch {}
      try { rec.unsubMedia?.(); } catch {}
      rec.pool.clear();
    }
    composerById.clear();
    listeners.clear();
  }

  globalThis.__agyInlineImages = {
    INLINE_IMG_PROVIDER,
    get enabled() { return enabled && !disposed; },
    setEnabled,
    setLanguage,
    prepareOutgoingPayload,
    buildPromptSectionForCascade,
    onMessageSent,
    clearComposerPool,
    dispose,
    // Exported pure helpers for direct unit tests and native-client.js reuse
    isImageMedia,
    extractDescriptionNumber,
    stripImagePrefix,
    tagMediaDescription,
    formatChipLabel,
    extractTextImageRefs,
    matchStepImages,
    buildInlineImageScopeItem,
    serializeInlineImageScopeItem,
    splitItemsWithInlineImages,
    parseMentionNodeInlineNumber,
    extractLexicalInlineImageNumbers,
    extractLexicalPlainImageRefs,
    convertPlainImageRefsInLexicalJson,
    collectConversationHistoryImages,
    syncOutgoingPayload,
    buildInlineImagePromptSection,
    bytesToBase64,
    mediaThumbSrc,
    mediaFullSrc
  };
})();
