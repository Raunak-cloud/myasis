import assert from 'node:assert/strict';
import { australianGovernmentDestination, isAustralianGovernmentUrl } from './site-policy.js';
import { authenticationValue, sitePassword } from './site-auth.js';
import type { CandidateProfile, FormField, JobListing } from './types.js';

assert.equal(isAustralianGovernmentUrl('https://jobs.nsw.gov.au/role/1'), true);
assert.equal(isAustralianGovernmentUrl('https://careers.health.qld.gov.au/job/1'), true);
assert.equal(isAustralianGovernmentUrl('https://governmentjobs.example.com/job/1'), false);
assert.equal(isAustralianGovernmentUrl('https://seek.com.au/job/1'), false);

const governmentJob = {
  id: '1',
  title: 'Role',
  company: 'Agency',
  location: 'Sydney',
  url: 'https://seek.com.au/job/1',
  description: 'Apply at https://jobs.nsw.gov.au/role/1',
} as JobListing;
assert.equal(australianGovernmentDestination(governmentJob), 'https://jobs.nsw.gov.au/role/1');

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

console.log('site policy and employer authentication checks passed');
