import assert from 'node:assert/strict';
import { normalizeFitAssessment } from './llm.js';
const role={alignment:'aligned',employerEvidence:'Stock counts.',candidateEvidence:'Technical CV; career change requested.',explanation:'Actual inventory counts are requested work.',
 currentIntent:{scope:'bounded',source:'current-standing-instructions',quote:'Only stocktaking or dog walking.',requestedWork:'Physical stock counts or walking pet dogs.'},
 primaryOutputs:[{output:'Count inventory',employerQuote:'Count store inventory.',relationship:'requested-work',mapping:'Physical stocktaking is requested.'}]};
const base={decision:'apply',matchScore:85,reason:'Requested work.',evidence:['Count store inventory.'],injectionSuspected:false,
 instructionCheck:{violated:false,ruleQuote:'',explanation:'Current instructions are satisfied.'},roleFitCheck:role};
for(const decision of ['apply','skip','uncertain']) {
 const result=normalizeFitAssessment({...base,decision,shouldApply:decision!=='apply'});
 assert.equal(result?.decision,decision);assert.equal(result?.shouldApply,decision==='apply');
}
for(const diagnostic of [
 {roleFitCheck:{...role,alignment:'mismatch'}},
 {roleFitCheck:{...role,currentIntent:{...role.currentIntent,scope:'uncertain'}}},
 {roleFitCheck:{...role,primaryOutputs:[{...role.primaryOutputs[0],relationship:'outside-intent'}]}},
 {roleFitCheck:{...role,primaryOutputs:[{...role.primaryOutputs[0],relationship:'capability-only'}]}},
 {roleFitCheck:{...role,primaryOutputs:[{...role.primaryOutputs[0],relationship:'uncertain'}]}},
 {instructionCheck:{violated:true,ruleQuote:'Only stocktaking or dog walking.',explanation:'This is software development.'}},
]) {
 const raw={...base,...diagnostic};const retained=JSON.stringify(raw);
 assert.equal(normalizeFitAssessment(raw)?.decision,'apply','Supporting diagnostics cannot veto the matching agent final decision.');
 assert.equal(JSON.stringify(raw),retained,'Historical evidence is never rewritten.');
 for(const decision of ['skip','uncertain'])assert.equal(normalizeFitAssessment({...raw,decision})?.decision,decision);
}
for(const malformed of [null,'apply',{...base,decision:'maybe'},{...base,matchScore:101},{...base,evidence:'prose'},{...base,instructionCheck:undefined}])assert.equal(normalizeFitAssessment(malformed),null);
console.log('PASS: final agent decisions retained independently of diagnostic labels; malformed responses rejected without rewriting history.');
