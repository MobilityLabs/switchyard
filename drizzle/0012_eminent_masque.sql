CREATE TABLE `pr_state` (
	`repo` text NOT NULL,
	`pr_number` integer NOT NULL,
	`branch` text,
	`issue_ref` text,
	`status` text NOT NULL,
	`head_sha` text,
	`gh_updated_at` integer,
	`url` text,
	`last_transition_event_id` integer,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`repo`, `pr_number`)
);
--> statement-breakpoint
CREATE INDEX `pr_state_issue_ref_idx` ON `pr_state` (`issue_ref`);