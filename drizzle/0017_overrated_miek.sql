CREATE TABLE `pr_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_id` integer NOT NULL,
	`repo` text NOT NULL,
	`pr_number` integer NOT NULL,
	`role` text NOT NULL,
	`declared_by` integer NOT NULL,
	`declared_at` integer DEFAULT (unixepoch()) NOT NULL,
	`confirmed_by` integer,
	`confirmed_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`declared_by`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`confirmed_by`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pr_links_live_idx` ON `pr_links` (`issue_id`,`repo`,`pr_number`) WHERE "pr_links"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX `pr_links_pr_idx` ON `pr_links` (`repo`,`pr_number`);--> statement-breakpoint
CREATE INDEX `pr_links_issue_idx` ON `pr_links` (`issue_id`);