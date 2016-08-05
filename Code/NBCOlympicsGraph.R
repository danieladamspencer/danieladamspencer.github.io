country = c(rep('US',3),rep('RUS',3),rep('GB',3))
Medal = rep(c('Gold','Silver','Bronze'),3)
counts = c(976.0, 759.5, 668.5, 440.0, 357.0,326.0, 233.5, 272.5, 271.5)

Oly = cbind(country,Medal,counts)

Olympics = as.data.frame(Oly)

Olympics$counts = as.numeric(levels(Olympics$counts))[Olympics$counts]
Olympics$Medal <- factor(Olympics$Medal,levels = c('Gold','Silver','Bronze'))

pos = numeric(9)
for(i in c(1,4,7)){
  pos[i:(i+2)] = cumsum(Olympics$counts[i:(i+2)]) - 0.5*Olympics$counts[i:(i+2)]
}

library(ggplot2)

g = ggplot(Olympics,aes(x = country,y=counts,fill = Medal)) + geom_bar(stat = 'identity') + ggtitle('Olympic Medals')
g = g + scale_fill_manual(values = c('#FFDF00','#C0C0C0','#CD7F32')) + scale_y_continuous(limits = c(0,2500))
g = g + geom_text(aes(label=counts, y = cumsum(counts) - 0.5*counts),size = 3)
g = g + labs(x='',y='Number of Medals') +coord_flip()
print(g)
