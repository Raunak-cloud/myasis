import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicUrl, isPublicAddress, publicFetch, publicWebsiteUrl } from './public-url.js';

test('customer websites reject credentials, ports, localhost and private IPs',()=>{
  for(const value of ['http://example.com','https://localhost/','https://10.0.0.1','https://127.1','https://name:password@example.com','https://example.com:8080','https://office.local']) assert.throws(()=>publicWebsiteUrl(value));
  assert.equal(publicWebsiteUrl('https://example.com/products'),'https://example.com/');
});
test('private, metadata, documentation and IPv6 transition networks are excluded',()=>{
  for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','172.20.0.1','192.168.1.1','100.64.1.1','198.51.100.1','203.0.113.1','::1','fc00::1','fe80::1','2001:db8::1','2001:0db8::1','2002:7f00:1::','::ffff:127.0.0.1']) assert.equal(isPublicAddress(ip),false,ip);
  for(const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111']) assert.equal(isPublicAddress(ip),true,ip);
});
test('private requests fail before a connection is made',async()=>{
  await assert.rejects(assertPublicUrl('http://127.0.0.1/'));
  await assert.rejects(publicFetch('http://169.254.169.254/latest/meta-data/'));
  await assert.rejects(publicFetch('file:///etc/passwd'));
});
