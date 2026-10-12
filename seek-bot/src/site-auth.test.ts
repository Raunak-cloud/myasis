import assert from 'node:assert/strict';
import { authenticationValue, sitePassword } from './site-auth.js';
import type { CandidateProfile, FormField } from './types.js';

const first = sitePassword('https://careers.example.com/login', 'person@example.com', 'deployment-secret');
const again = sitePassword('https://careers.example.com/register', 'person@example.com', 'deployment-secret');
const otherSite = sitePassword('https://jobs.example.net/register', 'person@example.com', 'deployment-secret');
assert.equal(first, again);
assert.notEqual(first, otherSite);
assert.match(first ?? '', /[A-Z]/);
assert.match(first ?? '', /[a-z]/);
assert.match(first ?? '', /\d/);
assert.match(first ?? '', /[^A-Za-z0-9]/);
assert.equal(sitePassword('https://example.com', 'person@example.com', ''), null);

const profile = {
  name: 'Rinu Thapa',
  email: 'rinu@example.com',
  phone: '0400000000',
} as CandidateProfile;
const field = (label: string, inputType = 'text', sensitive = false): FormField => ({
  ref: label,
  label,
  kind: 'text',
  inputType,
  required: true,
  sensitive,
});
assert.equal(authenticationValue(field('Email address', 'email'), profile, 'https://example.com'), profile.email);
assert.equal(authenticationValue(field('First name'), profile, 'https://example.com'), 'Rinu');
assert.equal(authenticationValue(field('Surname'), profile, 'https://example.com'), 'Thapa');
assert.equal(authenticationValue(field('Mobile', 'tel'), profile, 'https://example.com'), profile.phone);

console.log('employer authentication checks passed');
