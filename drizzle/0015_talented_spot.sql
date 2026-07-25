CREATE TABLE `pending_actions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`issue_id` integer NOT NULL,
	`action_type` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`affirmed_by_id` integer,
	`affirmed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`affirmed_by_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pending_actions_active_uniq` ON `pending_actions` (`session_id`,`issue_id`,`action_type`) WHERE status = 'pending';--> statement-breakpoint
ALTER TABLE `events` ADD `via_agent_id` integer REFERENCES actors(id);--> statement-breakpoint
ALTER TABLE `events` ADD `session_id` integer REFERENCES sessions(id);--> statement-breakpoint
ALTER TABLE `sessions` ADD `kind` text DEFAULT 'plain' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `via_agent_id` integer REFERENCES actors(id);--> statement-breakpoint
ALTER TABLE `sessions` ADD `closed_at` integer;