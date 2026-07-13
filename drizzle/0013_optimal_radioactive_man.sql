CREATE TABLE `delivery_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_ref` text NOT NULL,
	`pr_number` integer,
	`head_sha` text,
	`derived_head_sha` text,
	`authorization_id` integer NOT NULL,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`finished_at` integer,
	`outcome` text,
	FOREIGN KEY (`authorization_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `delivery_attempts_authorization_id_idx` ON `delivery_attempts` (`authorization_id`);--> statement-breakpoint
CREATE INDEX `delivery_attempts_issue_ref_idx` ON `delivery_attempts` (`issue_ref`);--> statement-breakpoint
CREATE TABLE `delivery_rollout` (
	`id` integer PRIMARY KEY NOT NULL,
	`completed_at` integer DEFAULT (unixepoch()) NOT NULL
);
