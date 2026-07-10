CREATE TABLE `agent_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_id` integer NOT NULL,
	`actor_id` integer NOT NULL,
	`mode` text NOT NULL,
	`pid` integer,
	`status` text DEFAULT 'running' NOT NULL,
	`exit_code` integer,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action
);
