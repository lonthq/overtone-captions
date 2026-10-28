// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import * as root from '../src/index';
import * as core from '../src/core/index';
import * as global from '../src/global';

describe('package entries', () => {
  it('the root entry exports the plugin, the controller and the button, not the rendering internals', () => {
    expect(Object.keys(root).sort()).toEqual(
      ['OvertoneCaptionsButton', 'OvertoneController', 'overtonePlugin', 'registerOvertone'].sort(),
    );
  });

  it('the <script> bundle (window.OvertoneVideojs) exports the root entry plus core', () => {
    expect(Object.keys(global).sort()).toEqual([...new Set([...Object.keys(root), ...Object.keys(core)])].sort());
    expect(typeof global.renderCue).toBe('function');
  });
});
