import assert from 'node:assert/strict';
import { kindOfDescriptor } from './mediaProbe';

assert.equal(kindOfDescriptor('clip.MOV', ''), 'video');
assert.equal(kindOfDescriptor('voice', 'audio/mpeg'), 'audio');
assert.equal(kindOfDescriptor('sticker.gif', 'application/octet-stream'), 'gif');
assert.equal(kindOfDescriptor('IMG_0001.HEIC', 'application/octet-stream'), 'image');
assert.equal(kindOfDescriptor('payload.exe', 'application/octet-stream'), null);
assert.equal(kindOfDescriptor('design.psd', 'image/vnd.adobe.photoshop'), null);
assert.equal(kindOfDescriptor('._clip.mp4', 'video/mp4'), null, 'AppleDouble sidecars are not video');
assert.equal(kindOfDescriptor('.DS_Store', ''), null);

console.log('mobileUploadApi.verify: ok');
