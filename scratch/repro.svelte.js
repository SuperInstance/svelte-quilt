import { tick, untrack } from 'svelte';

// repro 1: plain $effect outside any root — does it throw?
try {
  let x = 0;
  $effect(() => { x += 1; });
  console.log('repro1: no throw, x =', x);
} catch (e) {
  console.log('repro1: THROWS:', e.message ?? e);
}

// repro 2: $effect.root + untracked state write + tracked read
let dep = $state(1);
let fires = $state(0);
const destroy = $effect.root(() => {
  $effect(() => {
    if (fires < 0) return;
    untrack(() => { fires += 1; });
    void dep;
  });
  return () => {};
});
console.log('repro2: created, fires =', fires);
dep = 2;
await tick();
console.log('repro2: after dep change, fires =', fires);
destroy();

// repro 3: untracked write WITHOUT read of the written state at all
let dep3 = $state(1);
let last3 = $state(null);
const d3 = $effect.root(() => {
  $effect(() => {
    last3 = dep3 * 10;
  });
  return () => {};
});
console.log('repro3: created');
dep3 = 2;
await tick();
console.log('repro3: last3 =', last3, '(expect 20)');
d3();
