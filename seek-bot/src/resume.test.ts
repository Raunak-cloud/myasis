import assert from 'node:assert/strict';
import { resumeFileInputIndex } from './resume.js';

assert.equal(
  resumeFileInputIndex([
    { accept: 'image/jpeg,image/png', identity: 'profile-photo', context: 'Profile photo Upload' },
    { accept: '.doc,.docx,.pdf,.txt,.rtf', identity: 'document-upload', context: 'Résumé Upload Accepted file types' },
  ]),
  1,
  'chooses the résumé uploader instead of SEEK profile photo',
);

assert.equal(
  resumeFileInputIndex([
    { accept: 'image/*', identity: 'avatar', context: 'Upload profile picture' },
  ]),
  -1,
  'never treats an image-only uploader as a résumé uploader',
);

assert.equal(
  resumeFileInputIndex([
    { accept: '', identity: '', context: '' },
  ]),
  0,
  'keeps supporting a single generic file input on external application forms',
);

assert.equal(
  resumeFileInputIndex([
    { accept: 'application/pdf', identity: 'attachment', context: 'Attach your CV' },
    { accept: 'image/jpeg', identity: 'photo', context: 'Candidate headshot' },
  ]),
  0,
  'recognises MIME-based document uploaders',
);

console.log('résumé uploader selection checks passed');
