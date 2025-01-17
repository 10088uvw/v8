// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// Flags: --allow-natives-syntax --experimental-wasm-stack-switching
// Flags: --experimental-wasm-type-reflection --expose-gc

load("test/mjsunit/wasm/wasm-module-builder.js");

(function TestSuspender() {
  print(arguments.callee.name);
  let suspender = new WebAssembly.Suspender();
  assertTrue(suspender.toString() == "[object WebAssembly.Suspender]");
  assertThrows(() => WebAssembly.Suspender(), TypeError,
      /WebAssembly.Suspender must be invoked with 'new'/);
})();

(function TestSuspenderTypes() {
  print(arguments.callee.name);
  let builder = new WasmModuleBuilder();
  builder.addImport('m', 'import', kSig_v_i);
  builder.addFunction("export", kSig_i_i)
      .addBody([kExprLocalGet, 0]).exportFunc();
  builder.addFunction("wrong1", kSig_ii_v)
      .addBody([kExprI32Const, 0, kExprI32Const, 0]).exportFunc();
  builder.addFunction("wrong2", kSig_v_v)
      .addBody([]).exportFunc();
  let suspender = new WebAssembly.Suspender();
  function js_import(i) {
    return Promise.resolve(42);
  }

  // Wrap the import, instantiate the module, and wrap the export.
  let wasm_js_import = new WebAssembly.Function(
      {parameters: ['i32'], results: ['externref']}, js_import);
  let import_wrapper = suspender.suspendOnReturnedPromise(wasm_js_import);
  let instance = builder.instantiate({'m': {'import': import_wrapper}});
  let export_wrapper =
      suspender.returnPromiseOnSuspend(instance.exports.export);

  // Check type errors.
  wasm_js_import = new WebAssembly.Function(
      {parameters: [], results: ['i32']}, js_import);
  assertThrows(() => suspender.suspendOnReturnedPromise(wasm_js_import),
      TypeError, /Expected a WebAssembly.Function with return type externref/);
  assertThrows(() => suspender.returnPromiseOnSuspend(instance.exports.wrong1),
      TypeError,
      /Expected a WebAssembly.Function with exactly one return type/);
  assertThrows(() => suspender.returnPromiseOnSuspend(instance.exports.wrong2),
      TypeError,
      /Expected a WebAssembly.Function with exactly one return type/);
  // Signature mismatch (link error).
  let wrong_import = new WebAssembly.Function(
      {parameters: ['f32'], results: ['externref']}, () => {});
  wrong_import = suspender.suspendOnReturnedPromise(wrong_import);
  assertThrows(() => builder.instantiate({'m': {'import': wrong_import}}),
      WebAssembly.LinkError,
      /imported function does not match the expected type/);

  // Check the wrapped export's signature.
  let export_sig = WebAssembly.Function.type(export_wrapper);
  assertEquals(['i32'], export_sig.parameters);
  assertEquals(['externref'], export_sig.results);

  // Check the wrapped import's signature.
  let import_sig = WebAssembly.Function.type(import_wrapper);
  assertEquals(['i32'], import_sig.parameters);
  assertEquals(['externref'], import_sig.results);
})();

(function TestStackSwitchNoSuspend() {
  print(arguments.callee.name);
  let builder = new WasmModuleBuilder();
  builder.addGlobal(kWasmI32, true).exportAs('g');
  builder.addFunction("test", kSig_i_v)
      .addBody([
          kExprI32Const, 42,
          kExprGlobalSet, 0,
          kExprI32Const, 0]).exportFunc();
  let instance = builder.instantiate();
  let suspender = new WebAssembly.Suspender();
  let wrapper = suspender.returnPromiseOnSuspend(instance.exports.test);
  wrapper();
  assertEquals(42, instance.exports.g.value);
})();

(function TestStackSwitchSuspend() {
  print(arguments.callee.name);
  let builder = new WasmModuleBuilder();
  import_index = builder.addImport('m', 'import', kSig_i_v);
  builder.addFunction("test", kSig_i_v)
      .addBody([
          kExprCallFunction, import_index, // suspend
      ]).exportFunc();
  let suspender = new WebAssembly.Suspender();
  let js_import = suspender.suspendOnReturnedPromise(
      new WebAssembly.Function(
      {parameters: [], results: ['externref']},
      () => Promise.resolve(42)));
  let instance = builder.instantiate({m: {import: js_import}});
  let wrapped_export = suspender.returnPromiseOnSuspend(instance.exports.test);
  let combined_promise = wrapped_export();
  combined_promise.then(v => assertEquals(42, v));

  // Also try with a JS function with a mismatching arity.
  suspender = new WebAssembly.Suspender();
  js_import = suspender.suspendOnReturnedPromise(
      new WebAssembly.Function(
      {parameters: [], results: ['externref']},
      (unused) => Promise.resolve(42)));
  instance = builder.instantiate({m: {import: js_import}});
  wrapped_export = suspender.returnPromiseOnSuspend(instance.exports.test);
  combined_promise = wrapped_export();
  combined_promise.then(v => assertEquals(42, v));

  // Also try with a proxy.
  suspender = new WebAssembly.Suspender();
  js_import = suspender.suspendOnReturnedPromise(
      new WebAssembly.Function(
      {parameters: [], results: ['externref']},
      new Proxy(() => Promise.resolve(42), {})));
  instance = builder.instantiate({m: {import: js_import}});
  wrapped_export = suspender.returnPromiseOnSuspend(instance.exports.test);
  combined_promise = wrapped_export();
  combined_promise.then(v => assertEquals(42, v));
})();

// Check that we can suspend back out of a resumed computation.
(function TestStackSwitchSuspendLoop() {
  print(arguments.callee.name);
  let builder = new WasmModuleBuilder();
  builder.addGlobal(kWasmI32, true).exportAs('g');
  import_index = builder.addImport('m', 'import', kSig_i_v);
  // Pseudo-code for the wasm function:
  // for (i = 0; i < 5; ++i) {
  //   g = g + import();
  // }
  builder.addFunction("test", kSig_i_v)
      .addLocals(kWasmI32, 1)
      .addBody([
          kExprI32Const, 5,
          kExprLocalSet, 0,
          kExprLoop, kWasmVoid,
            kExprCallFunction, import_index, // suspend
            kExprGlobalGet, 0, // resume
            kExprI32Add,
            kExprGlobalSet, 0,
            kExprLocalGet, 0,
            kExprI32Const, 1,
            kExprI32Sub,
            kExprLocalTee, 0,
            kExprBrIf, 0,
          kExprEnd,
          kExprI32Const, 0,
      ]).exportFunc();
  let suspender = new WebAssembly.Suspender();
  let i = 0;
  // The n-th call to the import returns a promise that resolves to n.
  function js_import() {
    return Promise.resolve(++i);
  };
  let wasm_js_import = new WebAssembly.Function(
      {parameters: [], results: ['externref']}, js_import);
  let suspending_wasm_js_import =
      suspender.suspendOnReturnedPromise(wasm_js_import);
  let instance = builder.instantiate({m: {import: suspending_wasm_js_import}});
  let wrapped_export = suspender.returnPromiseOnSuspend(instance.exports.test);
  let chained_promise = wrapped_export();
  assertEquals(0, instance.exports.g.value);
  chained_promise.then(_ => assertEquals(15, instance.exports.g.value));
})();

(function TestStackSwitchGC() {
  print(arguments.callee.name);
  let builder = new WasmModuleBuilder();
  let gc_index = builder.addImport('m', 'gc', kSig_v_v);
  builder.addFunction("test", kSig_i_v)
      .addBody([kExprCallFunction, gc_index, kExprI32Const, 0]).exportFunc();
  let instance = builder.instantiate({'m': {'gc': gc}});
  let suspender = new WebAssembly.Suspender();
  let wrapper = suspender.returnPromiseOnSuspend(instance.exports.test);
  wrapper();
})();

// Check that the suspender does not suspend if the import's
// return value is not a promise.
(function TestStackSwitchNoPromise() {
  print(arguments.callee.name);
  let builder = new WasmModuleBuilder();
  builder.addGlobal(kWasmI32, true).exportAs('g');
  import_index = builder.addImport('m', 'import', kSig_i_v);
  builder.addFunction("test", kSig_i_v)
      .addBody([
          kExprCallFunction, import_index, // suspend
          kExprGlobalSet, 0, // resume
          kExprGlobalGet, 0,
      ]).exportFunc();
  let suspender = new WebAssembly.Suspender();
  function js_import() {
    return 42
  };
  let wasm_js_import = new WebAssembly.Function({parameters: [], results: ['externref']}, js_import);
  let suspending_wasm_js_import = suspender.suspendOnReturnedPromise(wasm_js_import);
  let instance = builder.instantiate({m: {import: suspending_wasm_js_import}});
  let wrapped_export = suspender.returnPromiseOnSuspend(instance.exports.test);
  let result = wrapped_export();
  // TODO(thibaudm): Check the result's value once this is supported.
  assertEquals(42, instance.exports.g.value);
})();

(function TestStackSwitchSuspendArgs() {
  print(arguments.callee.name);
  function reduce(array) {
    // a[0] + a[1] * 2 + a[2] * 3 + ...
    return array.reduce((prev, cur, i) => prev + cur * (i + 1));
  }
  let builder = new WasmModuleBuilder();
  // Number of param registers + 1 for both types.
  let sig = makeSig([kWasmI32, kWasmI32, kWasmI32, kWasmI32, kWasmI32, kWasmI32,
      kWasmF32, kWasmF32, kWasmF32, kWasmF32, kWasmF32, kWasmF32, kWasmF32], [kWasmI32]);
  import_index = builder.addImport('m', 'import', sig);
  builder.addFunction("test", sig)
      .addBody([
          kExprLocalGet, 0, kExprLocalGet, 1, kExprLocalGet, 2, kExprLocalGet, 3,
          kExprLocalGet, 4, kExprLocalGet, 5, kExprLocalGet, 6, kExprLocalGet, 7,
          kExprLocalGet, 8, kExprLocalGet, 9, kExprLocalGet, 10, kExprLocalGet, 11,
          kExprLocalGet, 12,
          kExprCallFunction, import_index, // suspend
      ]).exportFunc();
  let suspender = new WebAssembly.Suspender();
  function js_import(i1, i2, i3, i4, i5, i6, f1, f2, f3, f4, f5, f6, f7) {
    return Promise.resolve(reduce(Array.from(arguments)));
  };
  let wasm_js_import = new WebAssembly.Function(
      {parameters: ['i32', 'i32', 'i32', 'i32', 'i32', 'i32', 'f32', 'f32',
        'f32', 'f32', 'f32', 'f32', 'f32'], results: ['externref']}, js_import);
  let suspending_wasm_js_import =
      suspender.suspendOnReturnedPromise(wasm_js_import);

  let instance = builder.instantiate({m: {import: suspending_wasm_js_import}});
  let wrapped_export = suspender.returnPromiseOnSuspend(instance.exports.test);
  let args = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
  let combined_promise =
      wrapped_export.apply(null, args);
  combined_promise.then(v => assertEquals(reduce(args), v));
})();

(function TestStackSwitchReturnFloat() {
  print(arguments.callee.name);
  let builder = new WasmModuleBuilder();
  import_index = builder.addImport('m', 'import', kSig_f_v);
  builder.addFunction("test", kSig_f_v)
      .addBody([
          kExprCallFunction, import_index, // suspend
      ]).exportFunc();
  let suspender = new WebAssembly.Suspender();
  function js_import() {
    return Promise.resolve(0.5);
  };
  let wasm_js_import = new WebAssembly.Function(
      {parameters: [], results: ['externref']}, js_import);
  let suspending_wasm_js_import =
      suspender.suspendOnReturnedPromise(wasm_js_import);

  let instance = builder.instantiate({m: {import: suspending_wasm_js_import}});
  let wrapped_export = suspender.returnPromiseOnSuspend(instance.exports.test);
  let combined_promise = wrapped_export();
  combined_promise.then(v => assertEquals(0.5, v));
})();

// Throw an exception after the initial prompt.
(function TestStackSwitchException1() {
  print(arguments.callee.name);
  let builder = new WasmModuleBuilder();
  let tag = builder.addTag(kSig_v_v);
  builder.addFunction("throw", kSig_i_v)
      .addBody([kExprThrow, tag]).exportFunc();
  let instance = builder.instantiate();
  let suspender = new WebAssembly.Suspender();
  let wrapper = suspender.returnPromiseOnSuspend(instance.exports.throw);
  try {
    wrapper();
    assertUnreachable();
  } catch (e) {
    assertTrue(e instanceof WebAssembly.Exception);
  }
})();

// Throw an exception after the first resume event, which propagates to the
// promise wrapper.
(function TestStackSwitchException2() {
  print(arguments.callee.name);
  let tag = new WebAssembly.Tag({parameters: []});
  let builder = new WasmModuleBuilder();
  import_index = builder.addImport('m', 'import', kSig_i_v);
  tag_index = builder.addImportedTag('m', 'tag', kSig_v_v);
  builder.addFunction("test", kSig_i_v)
      .addBody([
          kExprCallFunction, import_index,
          kExprThrow, tag_index
      ]).exportFunc();
  let suspender = new WebAssembly.Suspender();
  function js_import() {
    return Promise.resolve(42);
  };
  let wasm_js_import = new WebAssembly.Function(
      {parameters: [], results: ['externref']}, js_import);
  let suspending_wasm_js_import =
      suspender.suspendOnReturnedPromise(wasm_js_import);

  let instance = builder.instantiate({m: {import: suspending_wasm_js_import, tag: tag}});
  let wrapped_export = suspender.returnPromiseOnSuspend(instance.exports.test);
  let combined_promise = wrapped_export();
  assertThrowsAsync(combined_promise, WebAssembly.Exception);
})();

(function TestStackSwitchPromiseReject() {
  print(arguments.callee.name);
  let tag = new WebAssembly.Tag({parameters: ['i32']});
  let builder = new WasmModuleBuilder();
  import_index = builder.addImport('m', 'import', kSig_i_v);
  tag_index = builder.addImportedTag('m', 'tag', kSig_v_i);
  builder.addFunction("test", kSig_i_v)
      .addBody([
          kExprTry, kWasmI32,
          kExprCallFunction, import_index,
          kExprCatch, tag_index,
          kExprEnd,
      ]).exportFunc();
  let suspender = new WebAssembly.Suspender();
  function js_import() {
    return Promise.reject(new WebAssembly.Exception(tag, [42]));
  };
  let wasm_js_import = new WebAssembly.Function(
      {parameters: [], results: ['externref']}, js_import);
  let suspending_wasm_js_import =
      suspender.suspendOnReturnedPromise(wasm_js_import);

  let instance = builder.instantiate({m: {import: suspending_wasm_js_import, tag: tag}});
  let wrapped_export = suspender.returnPromiseOnSuspend(instance.exports.test);
  let combined_promise = wrapped_export();
  assertPromiseResult(combined_promise, v => assertEquals(v, 42));
})();

(function TestReenterActiveSuspenderFails() {
  print(arguments.callee.name);
  let builder = new WasmModuleBuilder();
  let import_index = builder.addImport("m", "i", kSig_v_v);
  builder.addFunction("test", kSig_i_v)
      .addBody([
          kExprCallFunction, import_index,
          kExprI32Const, 0
          ]).exportFunc();
  let wrapped_export;
  function js_import() {
    wrapped_export(); // Re-enter the same wrapped export.
  }
  let instance = builder.instantiate({m: {i: js_import}});
  let suspender = new WebAssembly.Suspender();
  wrapped_export = suspender.returnPromiseOnSuspend(instance.exports.test);
  assertThrows(wrapped_export, WebAssembly.RuntimeError,
      /re-entering an active\/suspended suspender/);
})();

(function TestReenterSuspendedSuspenderFails() {
  print(arguments.callee.name);
  let builder = new WasmModuleBuilder();
  let import_index = builder.addImport("m", "i", kSig_v_v);
  builder.addFunction("test", kSig_i_v)
      .addBody([
          kExprCallFunction, import_index,
          kExprI32Const, 0
          ]).exportFunc();
  let suspender = new WebAssembly.Suspender();
  let i = suspender.suspendOnReturnedPromise(
      new WebAssembly.Function(
          {parameters: [], results: ['externref']},
          () => Promise.resolve(0)));
  let instance = builder.instantiate({m: {i}});
  let wrapped_export = suspender.returnPromiseOnSuspend(instance.exports.test);
  let promise1 = wrapped_export();
  // Re-enter the suspender before resolving the promise.
  assertThrows(wrapped_export, WebAssembly.RuntimeError,
      /re-entering an active\/suspended suspender/);
})();

function TestNestedSuspenders(suspend) {
  // Nest two suspenders. The call chain looks like:
  // outer (wasm) -> outer (js) -> inner (wasm) -> inner (js)
  // If 'suspend' is true, the inner JS function returns a Promise, which
  // suspends the inner wasm function, which returns a Promise, which suspends
  // the outer wasm function, which returns a Promise. The inner Promise
  // resolves first, which resumes the inner continuation. Then the outer
  // promise resolves which resumes the outer continuation.
  // If 'suspend' is false, the inner JS function returns a regular value and
  // no computation is suspended.
  print(arguments.callee.name);
  let builder = new WasmModuleBuilder();
  inner_index = builder.addImport('m', 'inner', kSig_i_v);
  outer_index = builder.addImport('m', 'outer', kSig_i_v);
  builder.addFunction("outer", kSig_i_v)
      .addBody([
          kExprCallFunction, outer_index
      ]).exportFunc();
  builder.addFunction("inner", kSig_i_v)
      .addBody([
          kExprCallFunction, inner_index
      ]).exportFunc();
  let outer_suspender = new WebAssembly.Suspender();
  let inner_suspender = new WebAssembly.Suspender();

  let inner = inner_suspender.suspendOnReturnedPromise(
      new WebAssembly.Function(
          {parameters: [], results: ['externref']},
          () => suspend ? Promise.resolve(42) : 42));

  let export_inner;
  let outer = outer_suspender.suspendOnReturnedPromise(
      new WebAssembly.Function(
          {parameters: [], results: ['externref']},
          () => export_inner()));

  let instance = builder.instantiate({m: {inner, outer}});
  export_inner = inner_suspender.returnPromiseOnSuspend(instance.exports.inner);
  let export_outer = outer_suspender.returnPromiseOnSuspend(instance.exports.outer);
  if (suspend) {
    assertPromiseResult(export_outer(), v => assertEquals(42, v));
  } else {
    assertEquals(export_outer(), 42);
  }
}

(function TestNestedSuspendersSuspend() {
  TestNestedSuspenders(true);
})();

(function TestNestedSuspendersNoSuspend() {
  TestNestedSuspenders(false);
})();

(function TestReenterInactiveSuspender() {
  print(arguments.callee.name);
  let builder = new WasmModuleBuilder();
  let import_index = builder.addImport("m", "i", kSig_i_v);
  builder.addFunction("test", kSig_i_v)
      .addBody([
          kExprCallFunction, import_index,
          ]).exportFunc();
  let suspender = new WebAssembly.Suspender();
  let i = suspender.suspendOnReturnedPromise(
      new WebAssembly.Function(
          {parameters: [], results: ['externref']},
          () => Promise.resolve(0)));
  let instance = builder.instantiate({m: {i}});
  let wrapped_export = suspender.returnPromiseOnSuspend(instance.exports.test);
  assertPromiseResult(
      wrapped_export(),
      () => assertPromiseResult(
          wrapped_export(),
          v => assertEquals(v, 0)));
})();
