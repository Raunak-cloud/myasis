import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AttentionPanel } from '../src/components/AttentionPanel';
import { ApplicationsPanel } from '../src/components/ApplicationsPanel';
import { PreparedApplications } from '../src/components/PreparedApplications';
import { plainReason, preparedStatusLabel, userFacingError } from '../src/run-messages';

test('attention loading and errors never claim the list is empty', () => {
  for (const props of [{ loading: true }, { loadError: 'Could not check your jobs. Please try again.' }]) {
    const html = renderToStaticMarkup(<AttentionPanel items={[]} {...props} />);
    assert.doesNotMatch(html, /No questions waiting/);
    assert.match(html, /Checking|Could not check/);
  }
  assert.match(renderToStaticMarkup(<AttentionPanel items={[]} />), /No questions waiting/);
});

test('application loading and errors never claim there are no applications', () => {
  for (const props of [{ loading: true }, { loadError: 'Could not load your applications. Please try again.' }]) {
    const html = renderToStaticMarkup(<ApplicationsPanel apps={[]} onChange={() => {}} followUpDays={14} {...props} />);
    assert.doesNotMatch(html, /No applications yet/);
    assert.match(html, /Loading your applications|Could not load/);
  }
});

test('prepared applications wait for data instead of briefly claiming the list is empty', () => {
  const html = renderToStaticMarkup(<PreparedApplications running={false} onStarted={() => {}} onCountChange={() => {}} />);
  assert.match(html, /Loading prepared applications/);
  assert.doesNotMatch(html, /No prepared applications yet/);
  assert.equal(preparedStatusLabel('approved', false), 'Waiting to submit');
  assert.equal(preparedStatusLabel('failed', false), 'Not completed');
  assert.equal(preparedStatusLabel('unexpected-provider-state', false), 'Status unavailable');
});

test('normal users see their actual question without diagnostic logs or a trace link', () => {
  const item = { jobId: 'test', title: 'Assistant', company: 'Employer', kind: 'question' as const, reason: 'TypeError: HTTP 503', url: 'https://example.test', at: '2026-10-25T00:00:00Z', questions: [{ question: 'Current clearance', options: ['None', 'Baseline'] }] };
  const html = renderToStaticMarkup(<AttentionPanel items={[item]} />);
  assert.match(html, /Current clearance/);
  assert.doesNotMatch(html, /TypeError|HTTP|View steps/);
  assert.match(renderToStaticMarkup(<AttentionPanel items={[item]} isAdmin />), /View steps/);
  assert.doesNotMatch(userFacingError(new Error('TypeError: HTTP 503 at https://private.example')), /TypeError|503|private/);
});

test('mailbox transport failures show a pending verification state without changing successful reads', () => {
  const reason = 'The account requires email verification. The Gmail MCP is unreachable, so the link cannot be retrieved programmatically.';
  const item = { jobId: 'mail-test', title: 'Analyst', company: 'Employer', kind: 'verification' as const, reason, url: 'https://example.test', at: '2026-10-30T00:00:00Z' };
  const html = renderToStaticMarkup(<AttentionPanel items={[item]} />);
  assert.match(html, /Email verification is pending/);
  assert.doesNotMatch(html, /MCP|unreachable|programmatically/);
  assert.equal(plainReason('Read the verification link through Gmail MCP.'), 'Read the verification link through Gmail.');
});
