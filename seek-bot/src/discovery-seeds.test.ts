import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverySeeds } from './discovery-seeds.js';

test('discovery leads strip supplied approvals, credentials, URLs, salaries and fit evidence',()=>{
 const input={id:'95369588',title:'Principal Penetration Tester',company:'Example',url:'http://127.0.0.1/private',
   source:'chosen',platform:'workday',salary:'$999999',ageDays:0,fitReview:{score:100},approved:true};
 assert.deepEqual(discoverySeeds([input,input]),[{id:input.id,title:input.title,company:input.company,location:'',platform:'seek',source:'search',url:'https://www.seek.com.au/job/95369588'}]);
 assert.equal(input.source,'chosen');
});

test('malformed and unbounded leads fail before any browser work',()=>{
 assert.deepEqual(discoverySeeds(undefined),[]);
 for(const value of [null,{},[null],[{id:'http://127.0.0.1',title:'Role',company:'Example'}],[{id:'95369588',title:' ',company:'Example'}],Array.from({length:51},()=>({id:'95369588',title:'Role',company:'Example'}))]){
  assert.throws(()=>discoverySeeds(value));
 }
});
