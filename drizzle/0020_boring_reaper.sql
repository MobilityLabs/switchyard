CREATE TABLE `supervised_claim_cutover` (
	`id` integer PRIMARY KEY NOT NULL,
	`completed_at` integer DEFAULT (unixepoch()) NOT NULL
);
