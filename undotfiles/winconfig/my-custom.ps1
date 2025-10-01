# remove pin to quick access from context menu
reg add "HKEY_CLASSES_ROOT\AllFilesystemObjects\shell\pintohome" /v LegacyDisable /f
reg add "HKEY_CLASSES_ROOT\Drive\shell\pintohome" /v LegacyDisable /f
reg add "HKEY_CLASSES_ROOT\Folder\shell\pintohome" /v LegacyDisable /f
reg add "HKEY_CLASSES_ROOT\Network\shell\pintohome" /v LegacyDisable /f

# set high performance power plan
$highPerfPlan = "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c"
powercfg /setactive $highPerfPlan
powercfg /change monitor-timeout-ac 0
powercfg /change monitor-timeout-dc 0