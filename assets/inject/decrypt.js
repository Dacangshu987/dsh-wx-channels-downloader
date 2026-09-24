/**
 * @file 视频解密模块
 */
console.log('[decrypt.js] 加载视频解密模块');

// ==================== WASM 解密相关 ====================
window.VTS_WASM_URL = "https://res.wx.qq.com/t/wx_fed/cdn_libs/res/decrypt-video-core/1.3.0/wasm_video_decode.wasm";
window.MAX_HEAP_SIZE = 33554432;

var decryptor_array;
var decryptor;
var __decrypt_loaded__ = false;
var __decrypt_cache__ = new Map();

function __wx_channels_video_decrypt(t, e, p) {
  for (var r = new Uint8Array(t), n = 0; n < t.byteLength && e + n < p.decryptor_array.length; n++) {
    r[n] ^= p.decryptor_array[n];
  }
  return r;
}

function wasm_isaac_generate(t, e) {
  decryptor_array = new Uint8Array(e);
  var r = new Uint8Array(Module.HEAPU8.buffer, t, e);
  decryptor_array.set(r.reverse());
  if (decryptor) {
    decryptor.delete();
  }
}

async function __wx_channels_decrypt(seed) {
  var cacheKey = String(seed);
  if (__decrypt_cache__.has(cacheKey)) {
    return __decrypt_cache__.get(cacheKey);
  }
  
  if (!__decrypt_loaded__) {
    await __wx_load_script("https://res.wx.qq.com/t/wx_fed/cdn_libs/res/decrypt-video-core/1.3.0/wasm_video_decode.js");
    __decrypt_loaded__ = true;
    await sleep();
  }
  
  decryptor = new Module.WxIsaac64(seed);
  decryptor.generate(131072);
  
  var result = new Uint8Array(decryptor_array);
  __decrypt_cache__.set(cacheKey, result);
  
  return result;
}

console.log('[decrypt.js] 视频解密模块加载完成');
