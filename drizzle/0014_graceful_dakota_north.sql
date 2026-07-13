CREATE TABLE `claim_lease_cutover` (
	`id` integer PRIMARY KEY NOT NULL,
	`completed_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `claim_leases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_id` integer NOT NULL,
	`actor_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`last_beat_at` integer NOT NULL,
	`invalidated_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claim_leases_token_hash_unique` ON `claim_leases` (`token_hash`);--> statement-breakpoint
CREATE INDEX `claim_leases_issue_id_idx` ON `claim_leases` (`issue_id`);