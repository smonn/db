// Run with `node --test prototypes/sql-type-class/e1-runtime-check/check.test.ts`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { defineDomain } from "../../../src/runtime/definition/define-domain.ts";
import { defineEnum } from "../../../src/runtime/definition/enum.ts";
import { factories as c } from "../../../src/runtime/definition/factories.ts";
import { assertComparable, type ColumnSide } from "./check.ts";

const mood = defineEnum(["sad", "ok", "happy"]);
const mood2 = defineEnum(["sad", "ok", "happy"]);
const mini = defineEnum(["sad", "ok"]);
const calm = defineDomain((b) => b.enum(mood));
const handle = defineDomain((b) => b.text());

const side = (label: string, column: { readonly state: ColumnSide["state"] }): ColumnSide => ({
  label,
  state: column.state,
});

test("the same enum compares", () => {
  assert.doesNotThrow(() => {
    assertComparable(side("users.mood", c.enum(mood)), side("posts.mood", c.enum(mood)));
  });
});

test("two enums with the same labels throw, naming both columns", () => {
  assert.throws(() => {
    assertComparable(side("users.mood", c.enum(mood)), side("posts.mood", c.enum(mood2)));
  }, /^Error: Can't compare users\.mood with posts\.mood: /u);
});

test("an enum and one with a subset of its labels throw", () => {
  assert.throws(() => {
    assertComparable(side("users.mood", c.enum(mood)), side("posts.mood", c.enum(mini)));
  }, /users\.mood with posts\.mood/u);
});

test("an enum and text throw", () => {
  assert.throws(() => {
    assertComparable(side("users.mood", c.enum(mood)), side("users.bio", c.text()));
  }, /users\.mood with users\.bio/u);
});

test("a domain over an enum and the enum itself throw", () => {
  assert.throws(() => {
    assertComparable(side("users.calm", c.domain(calm)), side("users.mood", c.enum(mood)));
  }, /users\.calm with users\.mood/u);
});

test("scalars of different factory types pass, as their class already decided", () => {
  assert.doesNotThrow(() => {
    assertComparable(side("a.n", c.integer()), side("b.n", c.numeric(10, 2)));
    assertComparable(side("a.t", c.text()), side("b.t", c.domain(handle)));
  });
});

test("arrays compare only with the identical element type", () => {
  assert.throws(() => {
    assertComparable(side("a.ids", c.integer().array()), side("b.ids", c.bigint().array()));
  }, /a\.ids with b\.ids/u);
  assert.throws(() => {
    assertComparable(side("a.t", c.text().array()), side("b.t", c.varchar(9).array()));
  }, /a\.t with b\.t/u);
  assert.throws(() => {
    assertComparable(side("a.t", c.text().array()), side("b.t", c.domain(handle).array()));
  }, /a\.t with b\.t/u);
  assert.throws(() => {
    assertComparable(side("a.m", c.enum(mood).array()), side("b.m", c.enum(mood2).array()));
  }, /a\.m with b\.m/u);
});

test("arrays differing only in type modifiers pass", () => {
  assert.doesNotThrow(() => {
    assertComparable(side("a.v", c.varchar(10).array()), side("b.v", c.varchar(20).array()));
    assertComparable(side("a.n", c.numeric(10, 2).array()), side("b.n", c.numeric().array()));
    assertComparable(side("a.m", c.enum(mood).array()), side("b.m", c.enum(mood).array()));
  });
});
