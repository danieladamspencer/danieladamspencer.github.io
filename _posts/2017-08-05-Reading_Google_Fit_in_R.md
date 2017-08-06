---
layout: post_page
title: "Reading Google Fit Data in R"
---


### 1. Grab your data from Google Takeout

Head over [here](https://takeout.google.com/settings/takeout) and grab your Fit data. If you want to look at/grab data from individual runs, you might only want to select "Activity Data" specifically, and leave the daily aggregations out of it.

### 2. Download GPSBabel

The [GPSBabel](https://www.gpsbabel.org/) website offers downloads of its program, as well as pretty decent support documents for a volunteer-supported project.

I did my work on a Windows 10 machine. If you are using Windows, you will need to add the folder you installed GPSBabel into to your path environment. [Stack Overflow](https://stackoverflow.com/questions/9546324/adding-directory-to-path-environment-variable-in-windows) has some good methods for doing this.

### 3. Read each of the TCX files into R


Since each activity has its information saved in a separate file, you will probably want to read in the data efficiently. I did something like this:

``` r
library(tidyverse)
library(maptools)
folder <- "C:/Users/Me/Containing_folder/"
tcx_files <- grep("Running.tcx",list.files(folder),value = T) %>% 
  .[-grep("Walking",.)] # I'm only interested in running activities
raw_read <- sapply(tcx_files,function(z){
  tryCatch(readGPS(i='gtrnctr',f=paste0(folder,z),type='t'),error = function(e) NULL)
},simplify = F) # There may be empty activity files. This keeps R from halting the read
nulls <- sapply(raw_read,is.null) 
raw_read <- raw_read[!nulls] # This takes out the empty activites
raw_read <- sapply(raw_read,function(z){ # This next bit takes care of an issue where lap identification 
  col_shift <- grep("LAP",z[,2])         # shifts the columns of the first few rows of the data frame
  z[col_shift,1:24] <- z[col_shift,3:26]
  z
},simplify = F)
info_columns <- c(3,4,13,16) # Latitude, Longitude, elevation (feet), time (seconds since midnight 1970-01-01 in UTC)
google_runs <- sapply(raw_read,function(z) {
  keep <- z[,info_columns] # Grabs the columns with the wanted information
  names(keep) <- c("lat","lon","ele","time") # Names the columns
  keep$ele <- gsub("F","",keep$ele) # Trims the "F" label off of the elevation data
  keep[,sapply(keep,class)=="factor"] <- sapply(keep[,sapply(keep,class)=="factor"],function(ff){
    as.numeric(as.character(ff))
  }) # As all variables should be numeric, this makes them that way
  keep$time <- as.POSIXct(as.numeric(as.character(keep$time)),origin="1970-01-01",tz="UTC")
  filter(keep,ele >= 0) # This is here in order to get rid of some problem data showing negative elevation
},simplify = F)
no_data <- sapply(google_runs,function(gr){dim(gr)[1]}) == 0 
google_runs <- google_runs[!no_data] # Remove any empty activity sets
```

### 4. Keep cleaning the data

The data is in R now, but it's far from clean. Depending on the phone used, the GPS may have decided that you plunged into the core of the Earth for a few seconds every once in a while. Or it might think you teleported into the next county for a span of ten seconds. Both of these happened in my data set.
