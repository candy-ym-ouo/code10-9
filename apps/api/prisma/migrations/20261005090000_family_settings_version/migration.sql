-- 家庭设置的乐观并发版本号：
-- 每次默认可见性 / 留言开关等设置落库时 +1，保存时必须带上读取到的版本，
-- 多管理员并发保存由服务端按版本做三方合并，旧历史条目的口径不受任何影响。
ALTER TABLE "families" ADD COLUMN "settings_version" INTEGER NOT NULL DEFAULT 1;
