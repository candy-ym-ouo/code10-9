-- AlterTable: 家庭设置增加乐观锁版本号，支持多管理员并发保存时按版本合并
ALTER TABLE "families" ADD COLUMN "settings_version" INTEGER NOT NULL DEFAULT 1;
