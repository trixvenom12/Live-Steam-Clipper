import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCreatorDisplayName,
  enforceShortsTitleRules,
  generateViralShortsTitle,
  MANDATORY_HASHTAGS,
} from '../src/youtube.js';

test('getCreatorDisplayName returns formatted names and handles short option', () => {
  assert.equal(getCreatorDisplayName('ishowspeed'), 'IShowSpeed');
  assert.equal(getCreatorDisplayName('@ishowspeed', true), 'Speed');
  assert.equal(getCreatorDisplayName('ohnepixel'), 'ohnePixel');
  assert.equal(getCreatorDisplayName('ohnepixel', true), 'ohne');
  assert.equal(getCreatorDisplayName('n3on'), 'N3on');
  assert.equal(getCreatorDisplayName('adinross'), 'Adin Ross');
  assert.equal(getCreatorDisplayName('@adinross', true), 'Adin');
});

test('enforceShortsTitleRules formats correctly and adds mandatory hashtags', () => {
  const raw = 'Speed BARKING AT GTA 6 COPS 🚨💀 #funnymoments';
  const formatted = enforceShortsTitleRules(raw);
  assert.ok(formatted.endsWith(MANDATORY_HASHTAGS));
  assert.ok(!formatted.includes('#funnymoments'));
  assert.ok(formatted.length <= 100);
});

test('generateViralShortsTitle produces catchy titles within 100 characters', () => {
  const clipSpeed = {
    transcript: 'Oh my god the police are chasing me! 5 star wanted level!',
    hook: 'Speed gets 5 stars',
  };
  const titleSpeed = generateViralShortsTitle(clipSpeed, 'ishowspeed');
  assert.ok(titleSpeed.length <= 100);
  assert.ok(titleSpeed.endsWith(MANDATORY_HASHTAGS));
  assert.ok(titleSpeed.includes('Speed') || titleSpeed.includes('IShowSpeed'));

  const clipOhne = {
    transcript: 'Bro look at this NPC what is he doing in Vice City',
    hook: 'ohne encounters funny NPC',
  };
  const titleOhne = generateViralShortsTitle(clipOhne, 'ohnepixel');
  assert.ok(titleOhne.length <= 100);
  assert.ok(titleOhne.endsWith(MANDATORY_HASHTAGS));
  assert.ok(titleOhne.includes('ohnePixel') || titleOhne.includes('ohne'));

  const clipN3on = {
    transcript: 'I died so fast bro the cops shot me',
    hook: 'N3on dies in GTA 6',
  };
  const titleN3on = generateViralShortsTitle(clipN3on, 'n3on');
  assert.ok(titleN3on.length <= 100);
  assert.ok(titleN3on.endsWith(MANDATORY_HASHTAGS));
  assert.ok(titleN3on.includes('N3on'));

  const clipAdin = {
    transcript: 'Adin trying to drive supercar and crashed into wall',
    hook: 'Adin crash',
  };
  const titleAdin = generateViralShortsTitle(clipAdin, 'adinross');
  assert.ok(titleAdin.length <= 100);
  assert.ok(titleAdin.endsWith(MANDATORY_HASHTAGS));
  assert.ok(titleAdin.includes('Adin Ross') || titleAdin.includes('Adin'));
});
