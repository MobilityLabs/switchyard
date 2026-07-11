PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_issues` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`summary` text,
	`status` text NOT NULL,
	`priority` text DEFAULT 'none' NOT NULL,
	`assignee_id` integer,
	`creator_id` integer NOT NULL,
	`parent_id` integer,
	`labels` text DEFAULT '[]' NOT NULL,
	`source_type` text,
	`source_detail` text,
	`source_url` text,
	`needs_input` integer DEFAULT false NOT NULL,
	`snoozed_until` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assignee_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`creator_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_issues`("id", "project_id", "number", "title", "description", "summary", "status", "priority", "assignee_id", "creator_id", "parent_id", "labels", "source_type", "source_detail", "source_url", "needs_input", "snoozed_until", "created_at", "updated_at") SELECT "id", "project_id", "number", "title", "description", "summary", "status", "priority", "assignee_id", "creator_id", "parent_id", "labels", "source_type", "source_detail", "source_url", "needs_input", "snoozed_until", "created_at", "updated_at" FROM `issues`;--> statement-breakpoint
DROP TABLE `issues`;--> statement-breakpoint
ALTER TABLE `__new_issues` RENAME TO `issues`;--> statement-breakpoint
PRAGMA foreign_keys=ON;