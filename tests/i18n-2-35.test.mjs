import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { toZhTw } from '../lib/zh-tw.mjs';

function loadT() {
  const document = { nodeType: 9, createTreeWalker: () => ({ nextNode: () => null }), querySelectorAll: () => [] };
  const context = vm.createContext({ document, NodeFilter: { SHOW_TEXT: 4 }, MutationObserver: class { observe() {} disconnect() {} }, __agyToZhTw: toZhTw });
  vm.runInContext(readFileSync(join(import.meta.dirname, '..', 'packages', 'i18n', 'native-i18n.js'), 'utf8'), context);
  return context.__agyI18n.t;
}

test('Antigravity 2.35.x strings flagged by agy-powertools v2.16.5 are translated', () => {
  const t = loadT();
  const expected = {
    'Search shortcuts...': '搜索快捷键...',
    'Search shortcuts…': '搜索快捷键…',
    'Settings for conversations outside of projects': '未关联项目的会话设置',
    'Hide breakdown': '隐藏明细',
    'Notification settings': '通知设置',
    'Automatic check for updates': '自动检查更新'
  };
  for (const [en, zh] of Object.entries(expected)) {
    assert.equal(t(en, 'zh-CN'), zh, en);
    assert.equal(t(en, 'en'), en, `${en} must pass through in English`);
    const tw = t(en, 'zh-TW');
    assert.notEqual(tw, en, `${en} must be translated in zh-TW`);
  }
  assert.equal(t('Notification settings', 'zh-TW'), '通知設定');
  assert.equal(t('Automatic check for updates', 'zh-TW'), '自動檢查更新');
});
