import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey(),
  username: text("username").unique().notNull(),
  password: text("password").notNull(), // TODO: use hashing
});

export const games = sqliteTable("games", {
  id: integer("id").primaryKey(),
  creatorId: integer("creator_id").notNull(),
  secondPlayerId: integer("second_player_id"),
  type: text("type").notNull(), // 'friend' or 'bot'
  timeLimit: integer("time_limit"), // in minutes, null = unlimited
  creatorColor: integer("creator_color").notNull(), // 1 = white, 2 = black
  createdAt: integer("created_at").notNull(),
  expireAt: integer("expire_at"),
  status: integer("status").notNull(), // 0 = pending, 1 = started, 2 = done, 3 = expired
  winner: integer("winner"), // 0 = white, 1 = black, null = pending
  rating: integer("rating").notNull(), // 0 = no, 1 = yes
  isPublic: integer("is_public").notNull(), // 0 = private, 1 = public
});

export const moves = sqliteTable("moves", {
  id: integer("id").primaryKey(),
  gameId: integer("game_id").notNull(),
  userId: integer("user_id").notNull(),
  color: integer("color").notNull(), // 1 = white, 2 = black
  move: text("move").notNull(), // algebraic notation
  createdAt: integer("created_at").notNull(),
});

export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey(),
  gameId: integer("game_id").notNull(),
  userId: integer("user_id").notNull(),
  message: text("message").notNull(),
  createdAt: integer("created_at").notNull(),
});
