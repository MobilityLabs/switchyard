CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_by_actor_id` integer,
	FOREIGN KEY (`updated_by_actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action
);
