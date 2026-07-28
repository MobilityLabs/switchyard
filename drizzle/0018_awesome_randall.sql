ALTER TABLE `issues` ADD `queue_rank` integer;--> statement-breakpoint
CREATE INDEX `issues_queue_rank_idx` ON `issues` (`queue_rank`);