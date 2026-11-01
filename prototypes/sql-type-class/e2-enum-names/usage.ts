// A schema of four tables and the same-type comparisons every shape accepts, identical in each
// shape's folder, so the shapes' instantiation counts compare like for like.
import { c, defineDomain, defineEnum, ref } from "./model.ts";

const mood = defineEnum("mood", ["sad", "ok", "happy"]);
const handle = defineDomain((b) => b.text(), { notNull: true });
const posint = defineDomain((b) => b.integer());

const users = {
  id: c.integer().identity(),
  handle: c.domain(handle).unique(),
  email: c.varchar(320).notNull().unique(),
  name: c.text().notNull(),
  bio: c.text(),
  mood: c.enum(mood).notNull().default("'ok'"),
  karma: c.domain(posint),
  tags: c.text().array().notNull().default("'{}'"),
  createdAt: c.timestamptz().notNull().default("now()"),
};

const posts = {
  id: c.uuid().primaryKey().default("gen_random_uuid()"),
  authorId: c
    .integer()
    .notNull()
    .references(() => users.id),
  title: c.text().notNull(),
  body: c.text().notNull(),
  score: c.numeric(10, 2).notNull().default("0"),
  views: c.bigint().notNull().default("0"),
  meta: c.jsonb<{ readonly pinned: boolean }>(),
  publishedOn: c.date(),
  createdAt: c.timestamptz().notNull().default("now()"),
};

const comments = {
  id: c.bigint().identity("always"),
  postId: c
    .uuid()
    .notNull()
    .references(() => posts.id),
  authorId: c
    .integer()
    .notNull()
    .references(() => users.id),
  body: c.text().notNull(),
  ratio: c.doublePrecision(),
  flagged: c.boolean().notNull().default("false"),
  createdAt: c.timestamp().notNull().default("now()"),
};

const files = {
  id: c.smallint().identity(),
  commentId: c.bigint().references(() => comments.id),
  data: c.bytea().notNull(),
  weight: c.real(),
  moods: c.enum(mood).array(),
  label: c.text().codec<URL>({ decode: (s) => new URL(s), encode: String }),
};

export function compare(): void {
  ref(posts.authorId).eq(ref(users.id));
  ref(comments.postId).eq(ref(posts.id));
  ref(comments.authorId).eq(ref(posts.authorId));
  ref(files.commentId).eq(ref(comments.id));
  ref(users.name).eq(ref(posts.title));
  ref(users.mood).eq(ref(users.mood));
  ref(users.createdAt).eq(ref(posts.createdAt));
  ref(users.id).eq(1);
  ref(posts.title).eq("hello");
  ref(users.mood).eq("ok");
  ref(files.moods).eq(["ok", null]);
  ref(comments.flagged).eq(true);
}
