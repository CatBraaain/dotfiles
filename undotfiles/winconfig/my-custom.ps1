# remove pin to quick access from context menu
reg add "HKEY_CLASSES_ROOT\AllFilesystemObjects\shell\pintohome" /v LegacyDisable /f
reg add "HKEY_CLASSES_ROOT\Drive\shell\pintohome" /v LegacyDisable /f
reg add "HKEY_CLASSES_ROOT\Folder\shell\pintohome" /v LegacyDisable /f
reg add "HKEY_CLASSES_ROOT\Network\shell\pintohome" /v LegacyDisable /f
# reg add "HKEY_LOCAL_MACHINE\SOFTWARE\Classes\CLSID\{679f85cb-0220-4080-b29b-5540cc05aab6}\shell\pintohome" /v LegacyDisable /f
# reg add "HKEY_LOCAL_MACHINE\SOFTWARE\Classes\CLSID\{f874310e-b6b7-47dc-bc84-b9e6b38f5903}\shell\pintohome" /v LegacyDisable /f

# set high performance power plan
$highPerfPlan = "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c"
powercfg /setactive $highPerfPlan
powercfg /change monitor-timeout-ac 0
powercfg /change monitor-timeout-dc 0