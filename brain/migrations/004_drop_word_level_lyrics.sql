-- Migration 004: Remove word-level (karaoke) lyrics pipeline

DROP TABLE IF EXISTS lyrics_jobs;

ALTER TABLE tracks DROP COLUMN lyrics_word_data;
