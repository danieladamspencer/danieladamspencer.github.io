Fit <- read.csv(file = "C:/Users/Dan/Downloads/takeout-20160530T232453Z/Takeout/Fit/Daily Aggregations/Daily Summaries.csv")

# I began running on August 3, 2015, so let's subset to after that date
Run <- Fit[-(1:279),]

library(ggplot2)
g1 <- ggplot(Run,aes(x=Running.duration..ms./60000)) + geom_histogram(binwidth=1) + labs(x = "Minutes of Running per Day",y="Number of Days")
g1 <- g1 + scale_x_continuous(breaks=seq(0,125,5),limits = c(0,120)) + scale_y_continuous(breaks=seq(0,35,2),limits = c(0,33))
g1 <- g1 + ggtitle("Running Time!")
print(g1)
