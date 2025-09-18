# $aliasPath = "$env:USERPROFILE\alias"
# $paths = @($aliasPath) + ($env:PATH -split ';' | ? { $_ -ne $aliasPath })
# [Environment]::SetEnvironmentVariable("Path", ($paths -join ';'), "Machine")
