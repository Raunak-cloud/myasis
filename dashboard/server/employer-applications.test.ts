import assert from 'node:assert/strict';
import {test} from 'node:test';
import {employerApplicationsEnabled,preserveEmployerSources} from '../src/employer-applications.js';
import {effectivePlatforms,applyRunPolicy,mayEditRunSetting} from './entitlements.js';
import {jobSourceSettingsError} from './job-sources.js';
import {RUN_SETTING_DEFAULTS,USER_SETTABLE_SETTINGS_KEYS} from './settings.js';

test('employer opt-out preserves choices and board access; re-enabling restores employer sources',()=>{
 assert.equal(employerApplicationsEnabled({}),true);
 assert.equal(employerApplicationsEnabled({EMPLOYER_APPLICATIONS_ENABLED:'false'}),false);
 assert(USER_SETTABLE_SETTINGS_KEYS.includes('EMPLOYER_APPLICATIONS_ENABLED'));
 assert(mayEditRunSetting('EMPLOYER_APPLICATIONS_ENABLED',{fineTune:false,advancedFilters:false}));
 for(const value of [true,false,'true','false'])assert.equal(jobSourceSettingsError({EMPLOYER_APPLICATIONS_ENABLED:value},false),null);
 assert.equal(jobSourceSettingsError({EMPLOYER_APPLICATIONS_ENABLED:'maybe'},false)?.status,400);
 const e={tier:'intensive' as const,fineTune:true,advancedFilters:true,indeedApplications:true,joraSignIn:true,employerSources:true,evaluationsPerRun:200,maxApplicationsPerRunOverride:null};
 const saved={...RUN_SETTING_DEFAULTS,PLATFORMS:'seek,indeed,greenhouse,pageup',PLATFORMS_CHOSEN:'1',EMPLOYER_SOURCES_CHOSEN:'1',JORA_BETA_ENABLED:'true',MIN_SALARY:'130000'};
 const before={...saved};
 assert.equal(effectivePlatforms({...saved,EMPLOYER_APPLICATIONS_ENABLED:'false'},e),'seek,indeed,jora');
 assert.equal(applyRunPolicy({...saved,EMPLOYER_APPLICATIONS_ENABLED:'false'},e,'auto',true,true).PLATFORMS,'seek,indeed,jora');
 assert.deepEqual(saved,before);
 const stored=preserveEmployerSources(saved.PLATFORMS,'indeed,jora',false);
 assert.equal(stored,'indeed,jora,greenhouse,pageup');
 assert.equal(effectivePlatforms({...saved,PLATFORMS:stored,EMPLOYER_APPLICATIONS_ENABLED:'true'},e),'indeed,jora,greenhouse,pageup');
 const free={...e,tier:'standard' as const,joraSignIn:false,indeedApplications:false,employerTrial:true,employerGuestOnly:true};
 assert.equal(effectivePlatforms({EMPLOYER_APPLICATIONS_ENABLED:'false'},free),'seek','disabled employer discovery must not run through the free Jora fallback');
 assert.equal(effectivePlatforms({},free),'smartrecruiters,greenhouse,jora','the original no-connection trial returns when enabled');
});
