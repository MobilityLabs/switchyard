CREATE TABLE `affirmation_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_id` integer NOT NULL,
	`public_key` text NOT NULL,
	`comment` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `affirmation_keys_active_uniq` ON `affirmation_keys` (`actor_id`,`public_key`) WHERE revoked_at is null;--> statement-breakpoint
ALTER TABLE `pending_actions` ADD `expires_at` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE `pending_actions` SET `expires_at` = `created_at` + 300 WHERE `expires_at` = 0;